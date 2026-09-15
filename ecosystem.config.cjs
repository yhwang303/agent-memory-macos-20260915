module.exports = {
  apps: [{
    name: 'codebuddy-worker',
    script: 'dist/bin/worker.js',
    args: 'start',
    cwd: 'D:\\GitHub\\agent-memory',
    
    // 环境变量
    env: {
      NODE_ENV: 'production',
      CODEBUDDY_MEM_PORT: '3847'
    },
    
    // 自动重启配置
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    
    // 日志配置
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    
    // 内存超限自动重启 (500MB)
    max_memory_restart: '500M',
    
    // 优雅关闭
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000
  }]
};
