require('dotenv').config();

const PAYSTACK_API = 'https://api.paystack.co';
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

async function initializePayment(email, amount, callbackUrl) {
    const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SECRET_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: email,
            amount: amount * 100, // Paystack uses kobo (smallest unit)
            callback_url: callbackUrl,
            metadata: { source: 'asksidney' }
        })
    });
    const data = await res.json();
    return data;
}

async function verifyPayment(reference) {
    const res = await fetch(`${PAYSTACK_API}/transaction/verify/${reference}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${SECRET_KEY}`
        }
    });
    const data = await res.json();
    return data;
}

module.exports = { initializePayment, verifyPayment };
