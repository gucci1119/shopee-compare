const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../shopee-openapi-sync.gs'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}

const thirdShops = { SG: '1938012197', TW: '1938012095', MY: '1938012258', PH: '1938012303', TH: '1938012329' };
const firstSg = '10101';
const secondSg = '20202';
const stockImages = ['item-front', 'item-back'];
const equal = (result, expected) => assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);

function setup(stubs = {}) {
  const calls = [];
  const store = {};
  const ctx = vm.createContext({
    ufDead_: () => false,
    ufTotal_: () => 1,
    ufStopLine_: () => 14000,
    ufToday_: () => '2026-11-09',
    baCcOfShop_: () => 'SG',
    baKv_: key => store[key],
    baKvSet_: (key, value) => { store[key] = value; },
    baKvFresh_: key => store[key],
    baKvFreshMany_: keys => Object.fromEntries(keys.map(key => [key, store[key]])),
    editSkip_: () => ({}),
    editRelist_: () => [],
    soldLikedMap_: () => ({}),
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: { formatDate: () => '11/10 02:05' },
    sbSelectAll_: () => [],
    callShop_: (shop, endpoint, query, method, body) => {
      calls.push({ shop, endpoint, body });
      if (endpoint.endsWith('/get_item_base_info')) {
        return { response: { item_list: [{ item_id: 321, item_status: 'NORMAL',
          image: { image_id_list: stockImages.concat('old-game') } }] } };
      }
      return { response: {} };
    },
    ...stubs,
  });
  vm.runInContext(section('var SHOP3_IDS_BY_MARKET', 'function shop3CandidateRead_') +
    section('var PROMO_BASE', 'var DNOTE_MARK') +
    section('function galleryFill_', '// ★明細画像をまとめて差し替える。'), ctx);
  ctx.DIMG_KEY = { SG: 'en' };
  store.promo_assets = { imgs: Object.fromEntries(ctx.PROMO_IMGS.map((name, i) => [name, 'promo-' + i])),
    gal: {}, strip: ['old-game'], vid: {} };
  return { ctx, store, calls };
}

test('the existing candidate and promo exclusion share the same five shop IDs', () => {
  const { ctx } = setup();
  equal(ctx.SHOP3_IDS_BY_MARKET, thirdShops);
  const candidate = section('function shop3CandidateRead_', 'var asins =');
  assert.match(candidate, /SHOP3_IDS_BY_MARKET\[market\]/);
  for (const shop of Object.values(thirdShops)) {
    assert.equal(ctx.isShop3Shop_(shop), true);
    assert.equal(ctx.isShop3Shop_(Number(shop)), true);
  }
  for (const shop of [firstSg, secondSg, 'SG', '19380121970', null]) {
    assert.equal(ctx.isShop3Shop_(shop), false);
  }
});

for (const [market, shop] of Object.entries(thirdShops)) {
  test(market + ' third shop does not merge new-listing photos or apply the promo batch', () => {
    const { ctx, calls } = setup({ baKv_: () => assert.fail('third shop should not fetch promo assets') });
    assert.equal(ctx.promoForNew_(shop, stockImages, null), null);
    equal(ctx.promoApply_(Number(shop), market, [321], false, false),
      { ok: true, skip: 'shop3', n: 0, items: [] });
    equal(ctx.promoApply_(shop, market, [321], true, true),
      { ok: true, skip: 'shop3', n: 0, items: [] });
    assert.deepEqual(calls, []);
  });
}

test('new catalog in same-country first and second shops still attaches configured promo media', () => {
  const { ctx, store, calls } = setup();
  const add = section('function addItem_(', 'function brandList_');
  const branch = add.match(/var _promo = null;\n[^\n]*promoForNew_.*\n/)[0];
  const after = add.match(/if \(itemId && _promo\)[^\n]+promoAfterCreate_[^\n]+/)[0];
  for (const shopId of [firstSg, secondSg, thirdShops.SG]) {
    ctx.shopId = shopId;
    ctx.imgIds = stockImages.slice();
    ctx.itemId = 321;
    ctx.result = {};
    ctx.body = {};
    store.promo_assets.vid.SG = { id: 'promo-video', shop: shopId };
    vm.runInContext(branch + after, ctx);
    if (shopId === thirdShops.SG) {
      equal(ctx.imgIds, stockImages);
      assert.equal(ctx.result.promo_video, undefined);
    } else {
      equal(ctx.imgIds, stockImages.concat(['promo-0', 'promo-1', 'promo-2', 'promo-3', 'promo-4', 'promo-5']));
      assert.equal(ctx.result.promo_video, 1);
    }
  }
  equal(calls.map(call => call.shop), [firstSg, secondSg]);
});

test('daily job filters the third SG shop before batching alongside the first two SG shops', () => {
  const rows = [
    { item_id: '111', shop_id: firstSg },
    { item_id: '222', shop_id: thirdShops.SG },
    { item_id: '333', shop_id: secondSg },
  ];
  const { ctx, store } = setup({ sbSelectAll_: (_table, query) => query.includes('cc=eq.SG&') ? rows : [] });
  store.promo_job = { on: true, mode: 'daily' };
  const batches = [];
  ctx.promoApply_ = (shop, _cc, items) => {
    batches.push([String(shop), ...items]);
    return { ok: true, items: items.map(item_id => ({ item_id, ok: true })) };
  };
  ctx.promoTickBody_();
  equal(batches, [[firstSg, '111'], [secondSg, '333']]);
  assert.equal(store.promo_job.n, 2);
});

test('third-shop photo fill appends only product photos, keeping the existing gallery and video untouched', () => {
  const { ctx, calls } = setup();
  const row = ctx.galleryFill_(thirdShops.SG, 321, ['new-item-photo', 'promo-2', 'old-game'], false, 5, 'test');
  assert.equal(row.added, 1);
  equal(calls[1].body, { item_id: 321, image: { image_id_list: stockImages.concat('old-game', 'new-item-photo') } });
});

test('third-shop photo fill keeps an already full nine-image gallery unchanged', () => {
  const gallery = ['item-front', 'item-back', 'old-game', 'promo-0', 'promo-1', 'promo-2', 'promo-3', 'promo-4', 'promo-5'];
  const { ctx } = setup({ callShop_: (_shop, endpoint) => {
    assert.equal(endpoint, '/api/v2/product/get_item_base_info');
    return { response: { item_list: [{ image: { image_id_list: gallery } }] } };
  } });
  const row = ctx.galleryFill_(thirdShops.SG, 321, ['new-item-photo'], false, 5, 'test');
  assert.equal(row.added, 0);
  equal(row.to, gallery);
});

test('first-shop photo fill preserves its existing promo behavior', () => {
  const { ctx, calls } = setup();
  const row = ctx.galleryFill_(firstSg, 321, ['new-item-photo'], false, 5, 'test');
  assert.equal(row.added, 1);
  equal(calls[1].body.image.image_id_list,
    stockImages.concat(['new-item-photo', 'promo-0', 'promo-1', 'promo-2', 'promo-3', 'promo-4', 'promo-5']));
});
