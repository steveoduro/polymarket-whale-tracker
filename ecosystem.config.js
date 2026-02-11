module.exports = {
  apps: [{
    name: 'weather-bot-v2',
    script: 'bot.js',
    cwd: '/home/deployer/polymarket-whale-tracker',
    node_args: '--experimental-vm-modules',
    env: {
      NODE_ENV: 'production',
    },
    // Restart on crash, max 10 restarts in 60s
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    // Logging
    error_file: '/home/deployer/.pm2/logs/weather-bot-v2-error.log',
    out_file: '/home/deployer/.pm2/logs/weather-bot-v2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }],
};
