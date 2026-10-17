// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'rs-tracker',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3320,
        POLL_MS: 120000,
      },
      max_memory_restart: '300M',
      restart_delay: 5000,
    },
  ],
};
