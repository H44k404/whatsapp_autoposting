document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === '1') {
    const errEl = document.getElementById('error-msg');
    if (errEl) errEl.classList.add('show');
  }

  const form = document.getElementById('login-form');
  const eyeBtn = document.querySelector('.eye-btn');

  function togglePassword() {
    const input = document.getElementById('password');
    const eyeIcon = document.getElementById('eye-icon');
    if (!input || !eyeIcon) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    eyeIcon.innerHTML = isHidden
      ? '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 001 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>'
      : '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
  }

  async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('error-msg');
    if (errEl) errEl.classList.remove('show');
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        window.location.href = '/';
      } else {
        const errText = document.getElementById('error-text');
        if (errText) errText.textContent = data.error || 'Invalid credentials.';
        if (errEl) errEl.classList.add('show');
      }
    } catch (err) {
      const errText = document.getElementById('error-text');
      if (errText) errText.textContent = 'Network error. Please try again.';
      if (errEl) errEl.classList.add('show');
    } finally {
      if (btn) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
  }

  if (form) form.addEventListener('submit', handleLogin);
  if (eyeBtn) eyeBtn.addEventListener('click', togglePassword);
});
