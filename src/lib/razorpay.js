const crypto = require('crypto');
const Razorpay = require('razorpay');

const instance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// amount is in rupees; Razorpay expects paise
async function createOrder({ amount, receipt }) {
  const order = await instance.orders.create({
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt,
  });
  return order;
}

function verifyPayment({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

module.exports = { createOrder, verifyPayment };
