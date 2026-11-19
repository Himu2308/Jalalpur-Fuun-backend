const crypto = require('crypto');
const Razorpay = require('razorpay');

const keyId = process.env.RAZORPAY_KEY_ID?.trim();
const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

const instance = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

// amount is in rupees; Razorpay expects paise
async function createOrder({ amount, receipt }) {
  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured');
    error.code = 'RAZORPAY_CONFIG_MISSING';
    throw error;
  }

  const order = await instance.orders.create({
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt,
  });
  return order;
}

function verifyPayment({ orderId, paymentId, signature }) {
  if (!keySecret) return false;

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

// Refund part (or all) of a captured payment. amount is in rupees. Resolves to Razorpay's refund
// object ({ id, status: 'pending' | 'processed' | 'failed', ... }); money reaches the customer in ~5-7 days.
async function refundPayment({ paymentId, amount, receipt, notes }) {
  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured');
    error.code = 'RAZORPAY_CONFIG_MISSING';
    throw error;
  }
  return instance.payments.refund(paymentId, {
    amount: Math.round(amount * 100),
    speed: 'normal',
    receipt,
    notes,
  });
}

async function fetchRefund(paymentId, refundId) {
  return instance.payments.fetchRefund(paymentId, refundId);
}

module.exports = { createOrder, verifyPayment, refundPayment, fetchRefund, keyId };
