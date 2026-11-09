const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../shopee-openapi-sync.gs'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}

const shopId = 12345;
const orderSn = 'TESTORDER123';
const packageNumber = '1234567891234567890';
const thermal = 'THERMAL_AIR_WAYBILL';
const normal = 'NORMAL_AIR_WAYBILL';
const orderDetail = { order_sn: orderSn, shop_id: shopId, order_status: 'PROCESSED',
  package_list: [{ package_number: packageNumber }], buyer_username: 'PRIVATE_TEST_USER' };
const documentType = { order_sn: orderSn, package_number: packageNumber,
  selectable_shipping_document_type: [thermal, normal], suggest_shipping_document_type: thermal,
  message: 'PRIVATE_TEST_MESSAGE' };

function probe(options = {}) {
  const calls = [];
  const context = vm.createContext({
    P_: () => ({ getProperty: key => key === 'WRITE_TOKEN' ? 'test-only-auth' : '' }),
    ufDead_: () => !!options.quotaBlocked,
    ufTotal_: () => options.quotaUsed || 0,
    UF_STOP: 14000,
    getToken_: () => options.token === undefined ? { shop_id: shopId, expire_at: 2000 } : options.token,
    now_: () => 1000,
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: text => ({ setMimeType: mime => {
        assert.equal(mime, 'JSON');
        return JSON.parse(text);
      } }),
    },
    callShop_: (...args) => {
      calls.push(args);
      if (options.apiError) throw new Error('PRIVATE_TOKEN_OR_REMOTE_MESSAGE');
      if (calls.length === 1) return { response: { order_list: options.orders || [orderDetail] } };
      if (calls.length === 2) return { response: { result_list: options.rows || [documentType] } };
      assert.fail('Unexpected additional Shopee API call');
    },
  });
  vm.runInContext(extract('function doPostInner_', 'function chatHash_') +
    extract('function slsAwbParameter_', 'function shipOrder_'), context);
  const body = { action: 'sls_awb_parameter', token: 'test-only-auth',
    shop_id: shopId, order_sn: orderSn, package_number: packageNumber, ...options.body };
  const result = context.doPostInner_({ postData: { contents: JSON.stringify(body) } });
  return { result, calls: JSON.parse(JSON.stringify(calls)) };
}

test('existing authenticated POST route checks the exact shipment and returns only allowed formats', () => {
  const { result, calls } = probe();
  assert.deepEqual(result, { ok: true, available: true, types: [thermal, normal], suggested: thermal });
  assert.deepEqual(calls, [
    [shopId, '/api/v2/order/get_order_detail', { order_sn_list: orderSn, response_optional_fields: 'package_list' }, 'get'],
    [shopId, '/api/v2/logistics/get_shipping_document_parameter', null, 'post',
      { order_list: [{ order_sn: orderSn, package_number: packageNumber }] }],
  ]);
});

test('normal and unknown formats do not imply that the current thermal label is available', () => {
  const { result } = probe({ rows: [{ ...documentType,
    selectable_shipping_document_type: [normal, 'PRIVATE_TEST_STRING'],
    suggest_shipping_document_type: 'PRIVATE_TEST_STRING',
  }] });
  assert.deepEqual(result, { ok: true, available: false, types: [normal], suggested: null });
});

for (const [label, options, expectedError, calls] of [
  ['invalid authentication', { body: { token: 'wrong' } }, /WRITE_TOKEN/, 0],
  ['malformed shop', { body: { shop_id: [shopId] } }, 'invalid_request', 0],
  ['more than one order', { body: { order_sn: orderSn + ',OTHERORDER1' } }, 'invalid_request', 0],
  ['missing package', { body: { package_number: '' } }, 'invalid_request', 0],
  ['numeric package could lose digits', { body: { package_number: Number(packageNumber) } }, 'invalid_request', 0],
  ['reserved quota', { quotaUsed: 13995 }, 'quota_reserved', 0],
  ['blocked quota', { quotaBlocked: true }, 'quota_reserved', 0],
  ['unauthorized shop', { token: null }, 'shop_token_unavailable', 0],
  ['token for another shop', { token: { shop_id: 987, expire_at: 2000 } }, 'shop_token_unavailable', 0],
  ['expiring token', { token: { shop_id: shopId, expire_at: 1050 } }, 'shop_token_unavailable', 0],
  ['wrong shop from order API', { orders: [{ ...orderDetail, shop_id: 987 }] }, 'arranged_package_unverified', 1],
  ['wrong order', { orders: [{ ...orderDetail, order_sn: 'OTHERORDER1' }] }, 'arranged_package_unverified', 1],
  ['unarranged order', { orders: [{ ...orderDetail, order_status: 'READY_TO_SHIP' }] }, 'arranged_package_unverified', 1],
  ['already shipped', { orders: [{ ...orderDetail, order_status: 'SHIPPED' }] }, 'arranged_package_unverified', 1],
  ['split order', { orders: [{ ...orderDetail, package_list: [{ package_number: packageNumber },
    { package_number: 'another-package' }] }] }, 'arranged_package_unverified', 1],
  ['different package', { orders: [{ ...orderDetail, package_list: [{ package_number: 'another-package' }] }] },
    'arranged_package_unverified', 1],
  ['different document package', { rows: [{ ...documentType, package_number: 'another-package' }] },
    'document_response_unverified', 2],
  ['missing document types', { rows: [{ ...documentType, selectable_shipping_document_type: null }] },
    'document_response_unverified', 2],
  ['document lookup failure', { rows: [{ ...documentType, fail_error: 'logistics.package_can_not_print',
    fail_message: 'PRIVATE_TEST_MESSAGE' }] }, 'document_query_failed', 2],
  ['API error does not disclose remote information', { apiError: true }, 'document_query_failed', 1],
]) {
  test(label, () => {
    const observation = probe(options);
    assert.equal(observation.result.ok, false);
    if (expectedError instanceof RegExp) assert.match(observation.result.error, expectedError);
    else assert.equal(observation.result.error, expectedError);
    assert.equal(observation.calls.length, calls);
    assert.equal(JSON.stringify(observation.result).includes('PRIVATE_'), false);
  });
}
