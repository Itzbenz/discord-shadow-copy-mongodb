module.exports = {
    apps : [{
        name: "discord-shadow-copy-mongodb",
        script: "./index.js",
        max_memory_restart: "100M",
        autorestart: true,
        env: {
            NODE_ENV: "development",
        },
        env_production: {
            NODE_ENV: "production",
        }
    }]
}
