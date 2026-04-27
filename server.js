require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('./supabase');
const paystack = require('./paystack');
const path = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.admin_key;
    const validKey = process.env.ADMIN_PASSKEY || 'sidney2026';
    if (key === validKey) return next();
    res.status(401).json({ error: 'Unauthorized.' });
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many login attempts.' } });
const accessCodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts.' } });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, message: { error: 'Too many requests.' } });
const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many applications.' } });

// ============ PAGES ============
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/portal', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'portal.html')); });
app.get('/sidney', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'sidney.html')); });
app.get('/admin.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/payment-verify.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'payment-verify.html')); });

// ============ AUTH ============
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { passkey } = req.body;
    const validKey = process.env.ADMIN_PASSKEY || 'sidney2026';
    if (passkey === validKey) return res.json({ success: true });
    res.status(401).json({ success: false });
});

// ============ APPLY ============
app.post('/api/apply', applyLimiter, async (req, res) => {
    const { full_name, email, phone, trading_experience, preferred_payment, payment_confirmation } = req.body;
    if (!full_name || !email) return res.status(400).json({ error: 'Name and email required.' });

    const { data, error } = await supabase.from('applicants').insert([{ full_name, email, phone, trading_experience, preferred_payment, status: 'pending' }]).select().single();
    if (error) return res.status(500).json({ error: 'Failed to submit.' });

    if (payment_confirmation && payment_confirmation !== 'Pending') {
        const { error: proofError } = await supabase.from('payment_proofs').insert({ applicant_email: email, message: payment_confirmation });
        if (proofError) console.error('Proof error:', proofError);
    }

    res.json({ success: true, applicant_id: data.id });
});

// ============ PAYSTACK ============
app.post('/api/paystack/initialize', async (req, res) => {
    const { email, amount } = req.body;
    if (!email || !amount) return res.status(400).json({ error: 'Email and amount required.' });
    const baseUrl = process.env.BASE_URL || 'https://asksidney.vercel.app';
    const callbackUrl = baseUrl + '/payment-verify.html';
    try {
        const result = await paystack.initializePayment(email, amount, callbackUrl);
        if (result.status) return res.json({ success: true, url: result.data.authorization_url, reference: result.data.reference });
        res.status(400).json({ error: result.message });
    } catch (err) { res.status(500).json({ error: 'Payment init failed.' }); }
});

app.get('/api/paystack/verify', async (req, res) => {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Reference required.' });
    try {
        const result = await paystack.verifyPayment(reference);
        if (!result.status || result.data.status !== 'success') return res.json({ success: false, message: 'Payment not verified.' });

        const email = result.data.customer.email;
        const amount = result.data.amount / 100;

        const { data: codes } = await supabase.from('access_codes').select('*').eq('is_used', false).limit(1);
        if (!codes || !codes.length) return res.json({ success: false, message: 'No codes available.' });

        const code = codes[0].code;
        const { error: linkError } = await supabase.from('mentees').upsert({ email, access_code: code, payment_status: 'verified', payment_amount: amount, payment_method: 'paystack' }, { onConflict: 'email' });
        if (linkError) { console.error('Link error:', linkError); return res.json({ success: false, message: 'Failed to link code.' }); }

        await supabase.from('access_codes').update({ is_used: true }).eq('code', code);
        res.json({ success: true, code });
    } catch (err) { console.error('Verify error:', err); res.status(500).json({ error: 'Verification failed.' }); }
});

// ============ PORTAL ACCESS ============
app.post('/api/verify-access', accessCodeLimiter, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ valid: false, message: 'Enter code.' });

    const { data: codeData } = await supabase.from('access_codes').select('*').eq('code', code).single();
    if (!codeData) return res.status(401).json({ valid: false, message: 'Invalid code.' });

    const { data: menteeData } = await supabase.from('mentees').select('*').eq('access_code', code).single();
    if (!menteeData) return res.status(401).json({ valid: false, message: 'No mentee found.' });

    await supabase.from('mentees').update({ portal_accessed: true }).eq('id', menteeData.id);

    res.json({ valid: true, mentee: { full_name: menteeData.full_name, email: menteeData.email, current_stage: menteeData.current_stage } });
});

// ============ ADMIN: APPLICANTS ============
app.get('/api/admin/applicants', adminAuth, apiLimiter, async (req, res) => {
    const { data, error } = await supabase.from('applicants').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed.' });
    res.json(data);
});

app.delete('/api/admin/applicants/:id', adminAuth, apiLimiter, async (req, res) => {
    await supabase.from('applicants').delete().eq('id', req.params.id);
    res.json({ success: true });
});

// ============ ADMIN: MENTEES ============
app.get('/api/admin/mentees', adminAuth, apiLimiter, async (req, res) => {
    const { data, error } = await supabase.from('mentees').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed.' });
    res.json(data);
});

app.post('/api/admin/update-stage', adminAuth, apiLimiter, async (req, res) => {
    const { email, stage } = req.body;
    await supabase.from('mentees').update({ current_stage: stage }).eq('email', email);
    res.json({ success: true });
});

app.delete('/api/admin/mentees/:id', adminAuth, apiLimiter, async (req, res) => {
    await supabase.from('mentees').delete().eq('id', req.params.id);
    res.json({ success: true });
});

// ============ ADMIN: ACCESS CODES ============
app.get('/api/admin/codes', adminAuth, apiLimiter, async (req, res) => {
    const { data, error } = await supabase.from('access_codes').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed.' });
    res.json(data);
});

app.post('/api/admin/generate-codes', adminAuth, apiLimiter, async (req, res) => {
    const { count = 5 } = req.body;
    const codes = [];
    for (let i = 0; i < count; i++) { codes.push({ code: 'SIDNEY-' + Math.random().toString(36).substring(2, 10).toUpperCase() }); }
    await supabase.from('access_codes').insert(codes);
    res.json({ success: true, codes: codes.map(c => c.code) });
});

app.post('/api/admin/link-mentee', adminAuth, apiLimiter, async (req, res) => {
    const { email, full_name, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required.' });
    const { data, error } = await supabase.from('mentees').upsert({ email, full_name: full_name || email.split('@')[0], access_code: code, payment_status: 'verified' }, { onConflict: 'email' }).select().single();
    if (error) return res.status(500).json({ error: 'Failed to link.' });
    await supabase.from('access_codes').update({ is_used: true }).eq('code', code);
    res.json({ success: true, mentee: data });
});

app.delete('/api/admin/codes/:id', adminAuth, apiLimiter, async (req, res) => {
    await supabase.from('access_codes').delete().eq('id', req.params.id);
    res.json({ success: true });
});

// ============ ADMIN: PAYMENTS ============
app.get('/api/admin/payment-proofs', adminAuth, apiLimiter, async (req, res) => {
    const { data, error } = await supabase.from('payment_proofs').select('*').order('uploaded_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed.' });
    res.json(data);
});

app.post('/api/admin/approve-payment', adminAuth, apiLimiter, async (req, res) => {
    const { proof_id, email } = req.body;
    await supabase.from('payment_proofs').update({ status: 'approved' }).eq('id', proof_id);
    const { data: codes } = await supabase.from('access_codes').select('*').eq('is_used', false).limit(1);
    if (!codes || !codes.length) return res.status(400).json({ error: 'No codes available.' });
    const code = codes[0].code;
    const { error: linkError } = await supabase.from('mentees').upsert({ email, access_code: code, payment_status: 'verified' }, { onConflict: 'email' });
    if (linkError) return res.status(500).json({ error: 'Failed to link.' });
    await supabase.from('access_codes').update({ is_used: true }).eq('code', code);
    res.json({ success: true, code });
});

app.delete('/api/admin/payment-proofs/:id', adminAuth, apiLimiter, async (req, res) => {
    await supabase.from('payment_proofs').delete().eq('id', req.params.id);
    res.json({ success: true });
});

// ============ ADMIN: SESSION NOTES ============
app.post('/api/admin/session-notes', adminAuth, apiLimiter, async (req, res) => {
    const { mentee_email, title, body } = req.body;
    if (!mentee_email || !title) return res.status(400).json({ error: 'Email and title required.' });
    await supabase.from('session_notes').insert({ mentee_email, title, body });
    res.json({ success: true });
});

app.get('/api/session-notes', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    const { data, error } = await supabase.from('session_notes').select('*').eq('mentee_email', email).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed.' });
    res.json(data);
});

// ============ ADMIN: RESOURCES ============
app.post('/api/admin/upload-resource', adminAuth, apiLimiter, upload.single('file'), async (req, res) => {
    const { filename, title, mentee_email } = req.body;
    if (!req.file || !filename || !title || !mentee_email) return res.status(400).json({ error: 'All fields required.' });
    const { error: uploadError } = await supabase.storage.from('resources').upload(filename, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) return res.status(500).json({ error: uploadError.message });
    await supabase.from('resources').insert({ mentee_email, title, filename });
    res.json({ success: true });
});

app.get('/api/resources', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    const { data, error } = await supabase.from('resources').select('*').eq('mentee_email', email).order('uploaded_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed.' });
    res.json(data);
});

// ============ HEALTH ============
app.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });

// ============ STATIC ============
app.use(express.static('public', { setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));

app.listen(PORT, () => { console.log('ASKSIDNEY running on http://localhost:' + PORT); });
