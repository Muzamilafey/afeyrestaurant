/**
 * Seed demo data ("Chili Grill & Lounge") for development and acceptance testing.
 *   npm run seed   → sets up the demo business on an empty database (or refreshes an existing demo)
 * Refuses to run in production.
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb, withTransaction } from '../db/connect';
import { isProd } from '../config/env';
import { Business, Branch, Role, User, Category, Product, ModifierGroup, TaxRate, Table, DiningArea, Ingredient, Customer, Employee, Shift, Supplier, DeliveryZone, Rider, LoyaltyAccount, Coupon } from '../models';
import { setupBusiness, getBusiness } from '../services/setup';
import { hashPassword } from '../auth/password';
import { saveIntegration } from '../services/integrations';
import { postMovement, saveRecipe } from '../services/inventory';

export const DEMO_PASSWORD = 'ChiliDemo#2026';
export const DEMO_PIN = '2580';

const ROLE_USERS: Array<[string, string, string]> = [
  ['general_manager', 'Grace Wanjiku', 'gm'],
  ['branch_manager', 'Brian Otieno', 'manager'],
  ['cashier', 'Cynthia Achieng', 'cashier'],
  ['waiter', 'Wycliffe Kiprop', 'waiter'],
  ['bartender', 'Baraka Mwangi', 'bartender'],
  ['chef', 'Chef Fatuma Ali', 'chef'],
  ['storekeeper', 'Samuel Njoroge', 'store'],
  ['procurement', 'Pauline Muthoni', 'procurement'],
  ['accountant', 'Andrew Kamau', 'accountant'],
  ['hr', 'Hellen Chebet', 'hr'],
  ['auditor', 'Ian Odhiambo', 'auditor'],
];

export async function seedDemo() {
  if (!(await getBusiness())) {
    await setupBusiness({
      name: 'Chili Grill & Lounge', contactPhone: '0700000000',
      branch: { name: 'Westlands', code: 'WST', address: 'Waiyaki Way, Westlands, Nairobi', phone: '0700000001' },
      owner: { name: 'Olivia Owner', email: 'owner@chili.demo', password: DEMO_PASSWORD },
    });
  }
  const business = (await getBusiness())!;
  const tenantId = business._id as Types.ObjectId;
  if (business.name !== 'Chili Grill & Lounge' || !(await User.exists({ tenantId, email: 'owner@chili.demo' }))) {
    throw new Error(`This database already belongs to "${business.name}". The demo seed only runs on an empty database or an existing demo.`);
  }
  await Business.updateOne({ _id: tenantId }, { $set: { kraPin: 'P051234567X', 'settings.alertEmails': ['owner@chili.demo'], 'branding.receiptHeader': 'Chili Grill & Lounge — Good food, cold drinks' } });

  const main = (await Branch.findOne({ tenantId, code: 'WST' }))!;
  await Branch.updateOne({ tenantId, _id: main._id }, { $set: { 'settings.serviceChargeBps': 500, 'settings.enabledModes': ['dine_in', 'takeaway', 'delivery', 'bar_counter', 'online'], 'settings.deliveryFee': 15000, 'settings.happyHours': [{ days: [1, 2, 3, 4, 5], start: '17:00', end: '19:00', discountBps: 2000, categoryIds: [] }] } });
  let second = await Branch.findOne({ tenantId, code: 'KLM' });
  if (!second) second = await Branch.create({ tenantId, name: 'Kilimani', code: 'KLM', address: 'Argwings Kodhek Rd, Kilimani' });

  // Users for every role
  const owner = await User.findOne({ tenantId, email: 'owner@chili.demo' });
  const pinHash = await hashPassword(DEMO_PIN);
  const pwHash = await hashPassword(DEMO_PASSWORD);
  if (owner) {
    owner.pinHash = pinHash;
    owner.branchIds = [main._id, second._id];
    await owner.save();
  }
  for (const [roleKey, name, local] of ROLE_USERS) {
    const role = await Role.findOne({ tenantId, key: roleKey });
    const email = `${local}@chili.demo`;
    await User.updateOne({ tenantId, email }, { $setOnInsert: { tenantId, email, name, passwordHash: pwHash, pinHash, roleId: role!._id, branchIds: [main._id], defaultBranchId: main._id } }, { upsert: true });
  }

  // Taxes: VAT inclusive active
  const vat = (await TaxRate.findOne({ tenantId, code: 'VAT' }))!;

  // Categories
  const catDefs = [
    ['Mains', 'utensils', 'food', 'kitchen'], ['Grill', 'beef', 'food', 'kitchen'], ['Starters', 'salad', 'food', 'kitchen'], ['Burgers', 'sandwich', 'food', 'kitchen'],
    ['Soft Drinks', 'cup-soda', 'soft_drink', 'bar'], ['Beer', 'beer', 'beer', 'bar'], ['Cocktails', 'martini', 'cocktail', 'bar'], ['Spirits', 'wine', 'spirit', 'bar'], ['Wine', 'wine', 'wine', 'bar'],
  ] as const;
  const cats: Record<string, Types.ObjectId> = {};
  for (const [i, [name, icon, kind, station]] of catDefs.entries()) {
    const c = await Category.findOneAndUpdate({ tenantId, name }, { $set: { icon, kind, station, sortOrder: i, active: true } }, { upsert: true, new: true });
    cats[name] = c!._id;
  }

  // Modifiers
  const doneness = await ModifierGroup.findOneAndUpdate({ tenantId, name: 'Doneness' }, { $set: { minSelect: 1, maxSelect: 1, options: [{ name: 'Rare', priceDelta: 0 }, { name: 'Medium', priceDelta: 0 }, { name: 'Well done', priceDelta: 0 }] } }, { upsert: true, new: true });
  const extras = await ModifierGroup.findOneAndUpdate({ tenantId, name: 'Extras' }, { $set: { minSelect: 0, maxSelect: 3, options: [{ name: 'Extra cheese', priceDelta: 10000 }, { name: 'Bacon', priceDelta: 15000 }, { name: 'Fried egg', priceDelta: 5000 }] } }, { upsert: true, new: true });
  const sides = await ModifierGroup.findOneAndUpdate({ tenantId, name: 'Side' }, { $set: { minSelect: 1, maxSelect: 1, options: [{ name: 'Chips', priceDelta: 0 }, { name: 'Ugali', priceDelta: 0 }, { name: 'Rice', priceDelta: 0 }, { name: 'Salad', priceDelta: 5000 }] } }, { upsert: true, new: true });
  const mixers = await ModifierGroup.findOneAndUpdate({ tenantId, name: 'Mixer' }, { $set: { minSelect: 0, maxSelect: 1, options: [{ name: 'Coke', priceDelta: 5000 }, { name: 'Tonic', priceDelta: 5000 }, { name: 'Soda water', priceDelta: 3000 }] } }, { upsert: true, new: true });

  // Ingredients
  const ingDefs: Array<{ name: string; kind: string; baseUnit: 'g' | 'ml' | 'pcs'; units?: Array<{ name: string; factor: number }>; containerSize?: number; isBarItem?: boolean; minLevel: number; cost: number; opening: number }> = [
    { name: 'Burger bun', kind: 'raw', baseUnit: 'pcs', minLevel: 20, cost: 2500, opening: 120 },
    { name: 'Beef patty', kind: 'raw', baseUnit: 'pcs', minLevel: 20, cost: 12000, opening: 100 },
    { name: 'Cheddar slice', kind: 'raw', baseUnit: 'pcs', minLevel: 30, cost: 2000, opening: 200 },
    { name: 'Burger sauce', kind: 'raw', baseUnit: 'ml', units: [{ name: 'bottle', factor: 1000 }], minLevel: 500, cost: 40, opening: 5000 },
    { name: 'Lettuce', kind: 'raw', baseUnit: 'g', units: [{ name: 'kg', factor: 1000 }], minLevel: 500, cost: 30, opening: 4000 },
    { name: 'Potatoes', kind: 'raw', baseUnit: 'g', units: [{ name: 'kg', factor: 1000 }, { name: 'sack', factor: 50000 }], minLevel: 10000, cost: 8, opening: 60000 },
    { name: 'Beef (nyama choma)', kind: 'raw', baseUnit: 'g', units: [{ name: 'kg', factor: 1000 }], minLevel: 5000, cost: 75, opening: 30000 },
    { name: 'Chicken (whole)', kind: 'raw', baseUnit: 'pcs', minLevel: 5, cost: 65000, opening: 30 },
    { name: 'Tilapia', kind: 'raw', baseUnit: 'pcs', minLevel: 5, cost: 45000, opening: 25 },
    { name: 'Maize flour', kind: 'raw', baseUnit: 'g', units: [{ name: 'kg', factor: 1000 }], minLevel: 5000, cost: 9, opening: 40000 },
    { name: 'Coca-Cola 300ml', kind: 'packaged_beverage', baseUnit: 'pcs', units: [{ name: 'crate', factor: 24 }], minLevel: 24, cost: 4500, opening: 96, isBarItem: true },
    { name: 'Tusker Lager 500ml', kind: 'beer', baseUnit: 'pcs', units: [{ name: 'crate', factor: 25 }], minLevel: 25, cost: 17000, opening: 100, isBarItem: true },
    { name: 'Tusker Keg', kind: 'beer', baseUnit: 'ml', units: [{ name: 'keg', factor: 50000 }, { name: 'pint', factor: 568 }], containerSize: 50000, minLevel: 10000, cost: 50, opening: 100000, isBarItem: true },
    { name: 'Gilbeys Gin 750ml', kind: 'spirit', baseUnit: 'ml', units: [{ name: 'bottle', factor: 750 }, { name: 'shot', factor: 25 }], containerSize: 750, minLevel: 750, cost: 160, opening: 7500, isBarItem: true },
    { name: 'Smirnoff Vodka 750ml', kind: 'spirit', baseUnit: 'ml', units: [{ name: 'bottle', factor: 750 }, { name: 'shot', factor: 25 }], containerSize: 750, minLevel: 750, cost: 180, opening: 7500, isBarItem: true },
    { name: 'Lime juice', kind: 'mixer', baseUnit: 'ml', units: [{ name: 'l', factor: 1000 }], minLevel: 500, cost: 30, opening: 5000, isBarItem: true },
    { name: 'Sugar syrup', kind: 'mixer', baseUnit: 'ml', units: [{ name: 'l', factor: 1000 }], minLevel: 500, cost: 15, opening: 4000, isBarItem: true },
    { name: 'Mint leaves', kind: 'raw', baseUnit: 'g', minLevel: 100, cost: 100, opening: 800, isBarItem: true },
    { name: 'Red wine 750ml', kind: 'wine', baseUnit: 'ml', units: [{ name: 'bottle', factor: 750 }, { name: 'glass', factor: 175 }], containerSize: 750, minLevel: 1500, cost: 150, opening: 9000, isBarItem: true },
  ];
  const ing: Record<string, Types.ObjectId> = {};
  for (const d of ingDefs) {
    const i = await Ingredient.findOneAndUpdate({ tenantId, name: d.name }, { $set: { kind: d.kind, baseUnit: d.baseUnit, units: d.units ?? [], containerSize: d.containerSize, isBarItem: !!d.isBarItem, minLevel: d.minLevel, lastCost: d.cost, active: true } }, { upsert: true, new: true });
    ing[d.name] = i!._id;
  }
  for (const b of [main, second]) {
    await withTransaction(async (session) => {
      for (const d of ingDefs) await postMovement({ tenantId, branchId: b._id, ingredientId: ing[d.name], type: 'opening', qty: d.opening, unitCost: d.cost, idempotencyKey: `opening:${b._id}:${ing[d.name]}`, reason: 'Demo opening stock' }, session);
    });
  }

  // Products (prices in cents)
  type PD = { name: string; cat: string; price: number; sku: string; plu?: string; barcode?: string; dietary?: string[]; mods?: Types.ObjectId[]; age?: boolean; hh?: number; variants?: Array<{ name: string; price: number }>; desc?: string; recipe?: Array<[string, number, string?]> };
  const prods: PD[] = [
    { name: 'Classic Beef Burger', cat: 'Burgers', price: 95000, sku: 'BRG-001', plu: '101', mods: [doneness!._id, extras!._id], desc: 'Grilled beef patty, cheddar, lettuce, house sauce', recipe: [['Burger bun', 1], ['Beef patty', 1], ['Cheddar slice', 1], ['Burger sauce', 20], ['Lettuce', 30]] },
    { name: 'Double Cheese Burger', cat: 'Burgers', price: 135000, sku: 'BRG-002', plu: '102', mods: [doneness!._id, extras!._id], recipe: [['Burger bun', 1], ['Beef patty', 2], ['Cheddar slice', 2], ['Burger sauce', 25], ['Lettuce', 30]] },
    { name: 'Nyama Choma (500g)', cat: 'Grill', price: 120000, sku: 'GRL-001', plu: '201', mods: [sides!._id], dietary: ['halal'], recipe: [['Beef (nyama choma)', 500], ['Maize flour', 150]] },
    { name: 'Quarter Chicken', cat: 'Grill', price: 75000, sku: 'GRL-002', plu: '202', mods: [sides!._id], recipe: [['Chicken (whole)', 0.25], ['Potatoes', 250]] },
    { name: 'Whole Fried Tilapia', cat: 'Mains', price: 110000, sku: 'MN-001', plu: '301', mods: [sides!._id], recipe: [['Tilapia', 1], ['Maize flour', 150]] },
    { name: 'Vegetable Curry', cat: 'Mains', price: 65000, sku: 'MN-002', plu: '302', dietary: ['vegetarian', 'vegan', 'spicy'], mods: [sides!._id] },
    { name: 'Masala Chips', cat: 'Starters', price: 35000, sku: 'ST-001', plu: '401', dietary: ['vegetarian', 'spicy'], recipe: [['Potatoes', 350]] },
    { name: 'Chicken Wings (6)', cat: 'Starters', price: 55000, sku: 'ST-002', plu: '402' },
    { name: 'Coca-Cola 300ml', cat: 'Soft Drinks', price: 15000, sku: 'SD-001', barcode: '5449000000996', recipe: [['Coca-Cola 300ml', 1]] },
    { name: 'Fresh Passion Juice', cat: 'Soft Drinks', price: 25000, sku: 'SD-002', dietary: ['vegan'] },
    { name: 'Tusker Lager 500ml', cat: 'Beer', price: 35000, sku: 'BR-001', barcode: '6161101600039', age: true, hh: 28000, recipe: [['Tusker Lager 500ml', 1]] },
    { name: 'Tusker Draught (pint)', cat: 'Beer', price: 30000, sku: 'BR-002', age: true, hh: 25000, recipe: [['Tusker Keg', 568]] },
    { name: 'Gin & Tonic', cat: 'Cocktails', price: 55000, sku: 'CK-001', age: true, recipe: [['Gilbeys Gin 750ml', 50], ['Lime juice', 10]] },
    { name: 'Mojito', cat: 'Cocktails', price: 65000, sku: 'CK-002', age: true, recipe: [['Smirnoff Vodka 750ml', 50], ['Lime juice', 30], ['Sugar syrup', 20], ['Mint leaves', 5]] },
    { name: 'Smirnoff Vodka (shot)', cat: 'Spirits', price: 25000, sku: 'SP-001', age: true, mods: [mixers!._id], recipe: [['Smirnoff Vodka 750ml', 1, 'shot']] },
    { name: 'House Red Wine', cat: 'Wine', price: 60000, sku: 'WN-001', age: true, variants: [{ name: 'Glass', price: 60000 }, { name: 'Bottle', price: 280000 }], recipe: [['Red wine 750ml', 1, 'glass']] },
  ];
  for (const [i, p] of prods.entries()) {
    const doc = await Product.findOneAndUpdate(
      { tenantId, sku: p.sku },
      { $set: { name: p.name, description: p.desc, categoryId: cats[p.cat], price: p.price, plu: p.plu, barcode: p.barcode, dietary: p.dietary ?? [], modifierGroupIds: p.mods ?? [], taxRateIds: [vat._id], ageRestricted: !!p.age, happyHourPrice: p.hh ?? null, variants: p.variants ?? [], status: 'available', sortOrder: i } },
      { upsert: true, new: true },
    );
    if (p.recipe) {
      const { Recipe } = await import('../models');
      if (!(await Recipe.exists({ tenantId, productId: doc!._id, variant: '' }))) {
        await saveRecipe(tenantId, { productId: doc!._id, lines: p.recipe.map(([n, q, u]) => ({ ingredientId: ing[n], qty: q, unit: u })) }, owner!._id);
      }
      if (p.variants?.length && p.name === 'House Red Wine' && !(await Recipe.exists({ tenantId, productId: doc!._id, variant: 'Bottle' }))) {
        await saveRecipe(tenantId, { productId: doc!._id, variant: 'Bottle', lines: [{ ingredientId: ing['Red wine 750ml'], qty: 1, unit: 'bottle' }] }, owner!._id);
      }
    }
  }

  // Floor plan
  for (const b of [main, second]) {
    const areas = ['Main Hall', 'Terrace', 'Bar Lounge'];
    for (const [ai, an] of areas.entries()) {
      const area = await DiningArea.findOneAndUpdate({ tenantId, branchId: b._id, name: an }, { $set: { sortOrder: ai } }, { upsert: true, new: true });
      for (let t = 1; t <= 4; t++) {
        const number = `${an[0]}${t}`;
        const capacity = an === 'Bar Lounge' ? 2 : t % 2 ? 6 : 4;
        // Two rows per area; six-seaters are drawn twice as wide.
        const layout = { x: ((t - 1) % 2) * 3, y: Math.floor((t - 1) / 2) * 2, w: capacity >= 6 ? 2 : 1, h: 1 };
        await Table.updateOne({ tenantId, branchId: b._id, number }, { $setOnInsert: { areaId: area!._id, capacity, shape: capacity >= 6 ? 'rect' : t % 2 ? 'square' : 'round' }, $set: { layout } }, { upsert: true });
      }
    }
  }

  // CRM, staff, suppliers, delivery
  const cust = await Customer.findOneAndUpdate({ tenantId, phone: '254712345678' }, { $set: { name: 'Jane Customer', email: 'jane@example.com', consent: { marketingSms: true, marketingEmail: false, birthdayOffers: true, updatedAt: new Date(), source: 'seed' }, 'credit.approved': true, 'credit.limit': 1000000 } }, { upsert: true, new: true });
  await LoyaltyAccount.updateOne({ tenantId, customerId: cust!._id }, { $setOnInsert: { points: 50, lifetimePoints: 50 } }, { upsert: true });
  await Coupon.updateOne({ tenantId, code: 'KARIBU10' }, { $setOnInsert: { type: 'percent', value: 10, active: true } }, { upsert: true });
  await Supplier.updateOne({ tenantId, name: 'Nairobi Fresh Produce Ltd' }, { $setOnInsert: { phone: '0711000111', email: 'orders@freshproduce.example', paymentTermsDays: 14 } }, { upsert: true });
  await Supplier.updateOne({ tenantId, name: 'EABL Distributors' }, { $setOnInsert: { phone: '0722000222', email: 'sales@eabl-dist.example', paymentTermsDays: 30 } }, { upsert: true });
  await DeliveryZone.updateOne({ tenantId, branchId: main._id, name: 'Westlands & Parklands' }, { $setOnInsert: { fee: 15000, etaMinutes: 35 } }, { upsert: true });
  await Rider.updateOne({ tenantId, branchId: main._id, name: 'Kevin (Rider)' }, { $setOnInsert: { phone: '0733000333' } }, { upsert: true });
  const shift = await Shift.findOneAndUpdate({ tenantId, branchId: main._id, name: 'Day' }, { $set: { start: '08:00', end: '17:00', breakMinutes: 60, graceMinutes: 10 } }, { upsert: true, new: true });
  const users = await User.find({ tenantId }).lean();
  let n = 1;
  for (const u of users) {
    await Employee.updateOne({ tenantId, employeeNo: `E${String(n).padStart(3, '0')}` }, { $setOnInsert: { branchId: main._id, userId: u._id, name: u.name, email: u.email, jobTitle: 'Staff', deviceUserCode: String(n) } }, { upsert: true });
    n++;
  }

  // Development-only simulated providers so the full flow can be exercised without credentials.
  if (!isProd) {
    for (const kind of ['mpesa', 'sms', 'email'] as const) {
      await saveIntegration(tenantId, kind, { provider: 'mock', enabled: true, environment: 'mock', settings: kind === 'sms' ? { senderId: 'CHILIPOS' } : kind === 'email' ? { fromEmail: 'noreply@chili.demo', fromName: 'Chili Grill' } : { shortCode: '174379', transactionType: 'CustomerPayBillOnline', accountReferenceFormat: '{order}', transactionDesc: 'Chili POS' } }, owner!._id);
    }
  }
  return { tenantId, mainBranchId: main._id, secondBranchId: second._id, shiftId: shift!._id };
}

if (require.main === module) {
  if (isProd && !process.argv.includes('--force')) {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
  }
  connectDb()
    .then(() => seedDemo())
    .then(async (r) => {
      console.log('Demo business ready:', r);
      console.log(`Sign in as owner@chili.demo / cashier@chili.demo / chef@chili.demo (see docs for all roles), password ${DEMO_PASSWORD}, approval PIN ${DEMO_PIN}`);
      await disconnectDb();
    })
    .catch(async (e) => {
      console.error(e);
      await disconnectDb();
      process.exit(1);
    });
}
