module.exports = {
    apps : [{
        name: "discord-shadow-copy-mongodb",
        script: "./index.js",
        max_memory_restart: "400M",
        autorestart: true,
        env: {
            NODE_ENV: "production",
        },

    }]
}
