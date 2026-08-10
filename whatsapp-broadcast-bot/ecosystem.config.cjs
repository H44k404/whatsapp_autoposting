module.exports = {
  apps: [
    {
      name: 'whatsapp-broadcast-bot',
      script: 'src/index.js',
      cwd: '/home/ubuntu/whatsapp_automation/whatsapp-broadcast-bot/whatsapp-broadcast-bot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
