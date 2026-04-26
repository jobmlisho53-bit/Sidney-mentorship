async function loadPayments() {
    const container = document.getElementById("paymentsList");
    try {
        const res = await fetch("/api/admin/payment-proofs");
        const data = await res.json();
        if (!data.length) {
            container.innerHTML = '<p style="color: var(--text-muted);">No payment proofs yet.</p>';
            return;
        }
        container.innerHTML = data.map(function(p) {
            var html = '<div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">';
            html += '<div>';
            html += '<p style="font-weight: 500;">' + p.applicant_email + '</p>';
            html += '<p style="color: var(--text-muted); font-size: 0.78rem;">' + new Date(p.uploaded_at).toLocaleString() + '</p>';
            html += '</div>';
            if (p.screenshot_url) {
                html += '<a href="' + p.screenshot_url + '" target="_blank" style="font-size: 0.8rem; color: #C9A830; text-decoration: none;">View Screenshot</a>';
            } else {
                html += '<span style="font-size: 0.8rem; color: var(--text-muted);">Message only</span>';
            }
            html += '<button onclick="approvePayment(\'' + p.id + '\', \'' + p.applicant_email + '\')" style="padding: 6px 16px; background: none; border: 1px solid #C9A830; color: #C9A830; cursor: pointer; font-size: 0.75rem; border-radius: 3px;">Approve</button>';
            html += '</div>';
            return html;
        }).join("");
    } catch (err) {
        container.innerHTML = '<p style="color: #B33A3A;">Failed to load.</p>';
    }
}

async function approvePayment(proofId, email) {
    try {
        var res = await fetch("/api/admin/approve-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proof_id: proofId, email: email })
        });
        var data = await res.json();
        if (data.success) {
            alert("Approved. Access code: " + data.code);
            loadPayments();
            loadMentees();
        }
    } catch (err) {}
}
