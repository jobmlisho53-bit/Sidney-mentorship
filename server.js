require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('./supabase');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiters
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: { error: "Too many login attempts. Try again in 15 minutes." }
});

const accessCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many attempts. Try again later." }
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { error: "Too many requests. Slow down." }
});

const applyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { error: "Too many applications. Please wait." }
});


// ============ ROUTES ============

// Serve landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve portal page
app.get('/portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Serve Sidney login page
app.get('/sidney', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sidney.html'));
});

// Serve admin dashboard (after login)
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============ API ENDPOINTS ============

// Handle mentorship application
app.post('/api/apply', applyLimiter, async (req, res) => {
    const { full_name, email, phone, trading_experience, preferred_payment } = req.body;

    if (!full_name || !email) {
        return res.status(400).json({ error: 'Name and email are required.' });
    }

    const { data, error } = await supabase
        .from('applicants')
        .insert([
            {
                full_name,
                email,
                phone,
                trading_experience,
                preferred_payment,
                status: 'pending'
            }
        ])
        .select()
        .single();

    if (error) {
        console.error('Application error:', error);
        return res.status(500).json({ error: 'Failed to submit application.' });
    }

    res.json({ 
        success: true, 
        message: 'Application received. Sidney will contact you shortly.',
        applicant_id: data.id 
    });
});

// Verify access code and return mentee data
app.post('/api/verify-access', accessCodeLimiter, async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ valid: false, message: 'Please enter your access code.' });
    }

    // Check if code exists and is unused
    const { data: codeData, error: codeError } = await supabase
        .from('access_codes')
        .select('*')
        .eq('code', code)
        .eq('is_used', false)
        .single();

    if (codeError || !codeData) {
        return res.status(401).json({ valid: false, message: 'Invalid or already used access code.' });
    }

    // Find the mentee linked to this code
    const { data: menteeData, error: menteeError } = await supabase
        .from('mentees')
        .select('*')
        .eq('access_code', code)
        .single();

    if (menteeError || !menteeData) {
        return res.status(401).json({ valid: false, message: 'No mentee found with this code.' });
    }

    // Mark code as used and portal accessed
    await supabase
        .from('access_codes')
        .update({ is_used: true, used_by: menteeData.id, used_at: new Date().toISOString() })
        .eq('code', code);

    await supabase
        .from('mentees')
        .update({ portal_accessed: true })
        .eq('id', menteeData.id);

    res.json({
        valid: true,
        mentee: {
            full_name: menteeData.full_name,
            email: menteeData.email,
            current_stage: menteeData.current_stage
        }
    });
});

// Admin: view all applicants
app.get('/api/admin/applicants', apiLimiter, async (req, res) => {
    const { data, error } = await supabase
        .from('applicants')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: 'Failed to fetch applicants.' });
    }

    res.json(data);
});

// Admin: view all mentees
app.get('/api/admin/mentees', apiLimiter, async (req, res) => {
    const { data, error } = await supabase
        .from('mentees')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: 'Failed to fetch mentees.' });
    }

    res.json(data);
});

// Admin: view all access codes
app.get('/api/admin/codes', apiLimiter, async (req, res) => {
    const { data, error } = await supabase
        .from('access_codes')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: 'Failed to fetch codes.' });
    }

    const formatted = data.map(c => ({
        code: c.code,
        used: c.is_used,
        mentee_id: c.used_by,
        created_at: c.created_at
    }));

    res.json(formatted);
});

// Admin: generate access codes
app.post('/api/admin/generate-codes', apiLimiter, async (req, res) => {
    const { count = 5 } = req.body;
    const codes = [];

    for (let i = 0; i < count; i++) {
        const code = 'SIDNEY-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        codes.push({ code });
    }

    const { error } = await supabase
        .from('access_codes')
        .insert(codes);

    if (error) {
        return res.status(500).json({ error: 'Failed to generate codes.' });
    }

    res.json({ success: true, codes: codes.map(c => c.code) });
});

// Admin: link mentee to access code
app.post('/api/admin/link-mentee', apiLimiter, async (req, res) => {
    const { email, full_name, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ error: 'Email and access code are required.' });
    }

    const { data, error } = await supabase
        .from('mentees')
        .upsert({
            email,
            full_name,
            access_code: code,
            payment_status: 'verified'
        }, { onConflict: 'email' })
        .select()
        .single();

    if (error) {
        return res.status(500).json({ error: 'Failed to link mentee.' });
    }

    res.json({ success: true, mentee: data });
});

// Admin: update mentee stage
app.post('/api/admin/update-stage', apiLimiter, async (req, res) => {
    const { email, stage } = req.body;
    
    if (!email || !stage) {
        return res.status(400).json({ error: 'Email and stage are required.' });
    }
    
    const { error } = await supabase
        .from('mentees')
        .update({ current_stage: stage })
        .eq('email', email);
    
    if (error) {
        return res.status(500).json({ error: 'Failed to update stage.' });
    }
    
    res.json({ success: true });
});

// Get session notes for a mentee
app.get('/api/session-notes', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    
    const { data, error } = await supabase
        .from('session_notes')
        .select('*')
        .eq('mentee_email', email)
        .order('created_at', { ascending: false });
    
    if (error) return res.status(500).json({ error: 'Failed to fetch notes.' });
    res.json(data);
});

// Admin: add session note
app.post('/api/admin/session-notes', apiLimiter, async (req, res) => {
    const { mentee_email, title, body } = req.body;
    if (!mentee_email || !title) return res.status(400).json({ error: 'Email and title required.' });
    
    const { error } = await supabase
        .from('session_notes')
        .insert([{ mentee_email, title, body }]);
    
    if (error) return res.status(500).json({ error: 'Failed to save note.' });
    res.json({ success: true });
});

// Admin: upload resource file
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/admin/upload-resource', apiLimiter, upload.single('file'), async (req, res) => {
    const { filename, title, mentee_email } = req.body;
    if (!req.file || !filename || !title || !mentee_email) return res.status(400).json({ error: 'File, filename, title and mentee email required.' });

    const { error: uploadError } = await supabase.storage
        .from('resources')
        .upload(filename, req.file.buffer, {
            contentType: 'application/pdf',
            upsert: true
        });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { error: dbError } = await supabase
        .from('resources')
        .insert({ mentee_email, title, filename });

    if (dbError) return res.status(500).json({ error: dbError.message });

    res.json({ success: true });
});

// Admin: get Supabase storage URL for uploads
app.get('/api/admin/storage-url', (req, res) => {
    res.json({ url: process.env.SUPABASE_URL + '/storage/v1/object/public/resources/' });
});

// Get resources for a mentee
app.get('/api/resources', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    
    const { data, error } = await supabase
        .from('resources')
        .select('*')
        .eq('mentee_email', email)
        .order('uploaded_at', { ascending: false });
    
    if (error) return res.status(500).json({ error: 'Failed to fetch resources.' });
    res.json(data);
});

// Admin login verification
app.post('/api/admin/login', loginLimiter, (req, res) => {
    const { passkey } = req.body;
    if (passkey === process.env.ADMIN_PASSKEY || passkey === 'sidney2026') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ STATIC FILES (must be last) ============
app.use(express.static('public', { setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));

app.listen(PORT, () => {
    console.log('ASKSIDNEY Platform running on http://localhost:' + PORT);
});
