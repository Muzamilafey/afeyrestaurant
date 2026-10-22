// PM2 process file: API (cluster) + one background worker. Usage: pm2 start deploy/ecosystem.config.js --env production
module.exports = {
  apps: [
    {
      name: 'chili-api',
      cwd: './server',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '600M',
      kill_timeout: 15000, // matches the API's graceful-shutdown window
      env_production: { NODE_ENV: 'production', RUN_WORKER_IN_PROCESS: 'false' },
      out_file: '/var/log/chili-pos/api.out.log',
      error_file: '/var/log/chili-pos/api.err.log',
      time: true,
    },
    {
      name: 'chili-worker',
      cwd: './server',
      script: 'dist/worker.js',
      instances: 1, // notifications, M-Pesa reconciliation, reminders and alerts
      max_memory_restart: '400M',
      env_production: { NODE_ENV: 'production' },
      out_file: '/var/log/chili-pos/worker.out.log',
      error_file: '/var/log/chili-pos/worker.err.log',
      time: true,
    },
  ],
};
