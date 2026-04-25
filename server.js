require('dotenv').config();
const express = require('express');
const supabase = require('./supabase');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve portal page
app.get('/portal', (req, res) => {
app.get('/sidney', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sidney.html'));
});
    res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Handle mentorship application
app.post('/api/apply', async (req, res) => {
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
        return res.status(500).json({ error: 'Failed to submit application. Please try again.' });
    }

    res.json({ 
        success: true, 
        message: 'Application received. Sidney will contact you shortly.',
        applicant_id: data.id 
    });
});

// Verify access code and return mentee data
app.post('/api/verify-access', async (req, res) => {
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

// Admin endpoint to view all applicants
app.get('/api/admin/applicants', async (req, res) => {
    const { data, error } = await supabase
        .from('applicants')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: 'Failed to fetch applicants.' });
    }

    res.json(data);
});

// Admin endpoint to view all mentees
app.get('/api/admin/mentees', async (req, res) => {
    const { data, error } = await supabase
        .from('mentees')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: 'Failed to fetch mentees.' });
    }

    res.json(data);
});

// Admin endpoint to generate new access codes
app.post('/api/admin/generate-codes', async (req, res) => {
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

// Admin endpoint to link a mentee to an access code
app.post('/api/admin/link-mentee', async (req, res) => {
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`ASKSIDNEY Platform running on http://localhost:${PORT}`);
});
