<?php

// E2E seed: one shop reachable at custom_domain "localhost" (the storefront
// forwards the browser's host, so a local Playwright run resolves to this
// shop), one manager who can transition orders, and one sellable part.
// Run through artisan tinker against the e2e database — see run.sh.

use App\Models\Company;
use App\Models\Manufacturer;
use App\Models\MasterPart;
use App\Models\Membership;
use App\Models\Part;
use App\Models\PartsGroup;
use App\Models\Series;
use App\Models\User;
use App\Models\Variant;
use App\Models\Vehicle;
use App\Models\VehicleModel;
use Illuminate\Support\Facades\Hash;

$shop = Company::create([
    'name' => 'E2E Otpad',
    'subdomain' => 'e2e-yard',
    'custom_domain' => 'localhost',
    'city' => 'Banja Luka',
    'phone' => '+38765000000',
    'email' => 'e2e@example.com',
    'is_active' => true,
    'settings' => ['shipping_flat_fee' => 10],
]);

$manager = User::create([
    'name' => 'E2E Manager',
    'email' => 'manager@e2e.test',
    'password' => Hash::make('password123'),
    'role' => 'manager',
    'company_id' => $shop->id,
    'is_active' => true,
]);

Membership::create([
    'user_id' => $manager->id,
    'company_id' => $shop->id,
    'role' => 'manager',
    'status' => 'active',
]);

$manufacturer = Manufacturer::create(['name' => 'BMW', 'slug' => 'bmw']);
$series = Series::create(['manufacturer_id' => $manufacturer->id, 'name' => 'Serija 3']);
$model = VehicleModel::create(['series_id' => $series->id, 'name' => 'E46']);
$variant = Variant::create(['vehicle_model_id' => $model->id, 'name' => '320d', 'engine_code' => 'M47']);

$group = PartsGroup::create(['slug' => 'motor', 'srb_name' => 'Motor', 'eng_name' => 'Engine']);
$masterPart = MasterPart::create([
    'parts_group_id' => $group->id,
    'slug' => 'alternator',
    'srb_name' => 'Alternator',
    'eng_name' => 'Alternator',
]);

$vehicle = Vehicle::create([
    'company_id' => $shop->id,
    'user_id' => $manager->id,
    'variant_id' => $variant->id,
    'year' => 2003,
    'color' => 'siva',
]);

Part::create([
    'company_id' => $shop->id,
    'vehicle_id' => $vehicle->id,
    'master_part_id' => $masterPart->id,
    'quantity' => 2,
    'quality' => 'excellent',
    'selling_price' => 150,
    'currency' => 'BAM',
    'is_available' => true,
    'is_reserved' => false,
]);

echo "seeded shop={$shop->id}\n";
