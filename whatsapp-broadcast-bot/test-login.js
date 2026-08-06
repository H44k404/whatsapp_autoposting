(async () => {
  try {
    const res = await fetch('http://127.0.0.1:3000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    console.log('Status:', res.status);
    console.log('Headers:');
    for (const [k, v] of res.headers) console.log(k + ':', v);
    const text = await res.text();
    console.log('\nBody:\n', text);
  } catch (e) {
    console.error('Error:', e);
  }
})();
