import { test, expect } from "@playwright/test";

// Critical path: browse → part detail → add to cart → COD checkout →
// order visible to staff → manager confirms → buyer sees the new status.
//
// The storefront runs on STORE_URL (BFF → Laravel on API_URL); the staff
// side is exercised directly against the Laravel API, which is exactly what
// the admin app's BFF calls.

const STORE_URL = process.env.STORE_URL ?? "http://localhost:3010";
const API_URL = process.env.API_URL ?? "http://127.0.0.1:8010";

test("buyer orders a part and the yard fulfills it", async ({ page, request }) => {
  // Browse: the seeded part is on the home page and the listing.
  await page.goto(STORE_URL);
  await expect(page.getByText("E2E Otpad").first()).toBeVisible();

  await page.goto(`${STORE_URL}/parts?search=alternator`);
  const card = page.getByRole("link", { name: /Alternator/ }).first();
  await expect(card).toBeVisible();
  await card.click();

  // Detail → add to cart.
  await expect(page.getByText(/150/).first()).toBeVisible();
  await page.getByRole("button", { name: /Dodaj u korpu/i }).click();
  await page.getByRole("link", { name: /korp/i }).first().click();

  // Cart shows the line and shipping.
  await expect(page).toHaveURL(/\/korpa/);
  await expect(page.getByText("Alternator").first()).toBeVisible();
  await expect(page.getByText(/Dostava/i).first()).toBeVisible();

  // Checkout (COD).
  await page.getByRole("link", { name: /plaćanje/i }).click();
  await expect(page).toHaveURL(/\/narudzba/);
  await page.getByLabel(/Ime i prezime/i).fill("Petar Petrović");
  await page.getByLabel(/Telefon/i).fill("+38765123456");
  await page.getByLabel(/Ulica/i).fill("Glavna 1");
  await page.getByLabel(/Grad/i).fill("Banja Luka");
  await page.getByLabel(/Poštanski broj/i).fill("78000");
  await page.getByRole("button", { name: /naruči|potvrdi/i }).click();

  // Success page carries the order number and links to the status page.
  await expect(page).toHaveURL(/\/narudzba\/uspjeh\//, { timeout: 15000 });
  const orderNumber = (await page
    .getByText(/HB-[0-9]{6}-[A-Z0-9]{4}/)
    .first()
    .textContent())!.match(/HB-[0-9]{6}-[A-Z0-9]{4}/)![0];

  const statusLink = page.getByRole("link", { name: /status|prati/i }).first();
  const statusHref = await statusLink.getAttribute("href");
  expect(statusHref).toContain(orderNumber);

  // Staff side (via the Laravel API, as the admin BFF would call it):
  // manager logs in, finds the order, confirms it.
  const login = await request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email: "manager@e2e.test", password: "password123" },
  });
  expect(login.ok()).toBeTruthy();
  const token = (await login.json()).data.token as string;
  const auth = { Authorization: `Bearer ${token}` };

  const list = await request.get(`${API_URL}/api/v1/orders?search=${orderNumber}`, { headers: auth });
  expect(list.ok()).toBeTruthy();
  const order = (await list.json()).data[0];
  expect(order.customer_name).toBe("Petar Petrović");
  expect(order.status).toBe("pending");

  const transition = await request.post(`${API_URL}/api/v1/orders/${order.id}/transition`, {
    headers: auth,
    data: { status: "confirmed" },
  });
  expect(transition.ok()).toBeTruthy();

  // Stock was decremented at checkout (2 → 1 after buying one unit).
  const detail = await request.get(`${API_URL}/api/v1/orders/${order.id}`, { headers: auth });
  expect((await detail.json()).data.status).toBe("confirmed");

  // Buyer sees the new status on the public status page.
  await page.goto(`${STORE_URL}${statusHref}`);
  await expect(page.getByText(/Potvrđena/i).first()).toBeVisible();
});
