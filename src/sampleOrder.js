// ============================================================
//  src/sampleOrder.js
//  A realistic mock Shopify "orders/create" payload used by the
//  "Test send" feature so the full resolve+send pipeline can be
//  exercised without a real order.
// ============================================================
export function buildSampleOrder(overrides = {}) {
  const order = {
    id: 450789469,
    name: '#1001',
    order_number: 1001,
    currency: 'EGP',
    total_price: '349.00',
    financial_status: 'paid',
    fulfillment_status: null,
    phone: null,
    customer: {
      first_name: 'Sara',
      last_name: 'Ahmed',
      phone: '01001234567',
      email: 'sara@example.com',
    },
    line_items: [
      { title: 'Leather Sneakers', quantity: 1, name: 'Leather Sneakers' },
      { title: 'Shoe Care Kit', quantity: 2, name: 'Shoe Care Kit' },
    ],
    shipping_address: {
      name: 'Sara Ahmed',
      address1: '12 Tahrir Street',
      address2: 'Apt 4',
      city: 'Cairo',
      province: 'Cairo',
      country: 'Egypt',
      zip: '11511',
      phone: '01001234567',
    },
    billing_address: {
      name: 'Sara Ahmed',
      address1: '12 Tahrir Street',
      address2: 'Apt 4',
      city: 'Cairo',
      province: 'Cairo',
      country: 'Egypt',
      zip: '11511',
      phone: '01001234567',
    },
  };
  return { ...order, ...overrides };
}

export default { buildSampleOrder };
