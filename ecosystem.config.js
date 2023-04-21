module.exports = {
    apps : [{
        name: "discord-shadow-copy-mongodb",
        script: "./index.js",
        env: {
            NODE_ENV: "development",
        },
        env_production: {
            NODE_ENV: "production",
        }
    }]
}
