const {Client, Collection} = require('discord.js-selfbot-v13');
const CachedManager = require('discord.js-selfbot-v13/src/managers/CachedManager');
require('dotenv').config();
const {MongoClient} = require("mongodb");
const mongoClient = new MongoClient(process.env.MONGO_URL, {useNewUrlParser: true, useUnifiedTopology: true});
const database = mongoClient.db(process.env.MONGO_DB);


const client = new Client({
    // See other options here
    // https://discordjs-self-v13.netlify.app/#/docs/docs/main/typedef/ClientOptions
    // All partials are loaded automatically
    checkUpdate: false,
});


const ignoreDuplicateErrorHandler = (error) => {
    if (error.code === 11000) {
        return;
    }
    console.error(error);
}
const alreadyIndexed = [];
client.on('ready', async () => {
    console.log(`${client.user.tag} is ready!`);

    //synchronize guilds, channels, users
    const guilds = client.guilds.cache;
    console.log(`Guilds: ${guilds.size}`);

    //sample
    console.log(`Guild`, guilds.last());


    // add or update to database
    database.collection('guilds').insertMany(guilds.map(serializer.guild)).catch(ignoreDuplicateErrorHandler);


    // Hijack and wrap CachedManager _add
    // _add(data, cache = true, { id, extras = [] } = {}) {
    const _add = CachedManager.prototype._add;

    const blacklistedManager = ['GuildEmojiRoleManager', 'GuildEmojiManager', 'GuildStickerManager', 'ReactionManager'];
    const logged = [];
    CachedManager.prototype._add = function (data, cache = true, {id, extras = []} = {}) {
        const newData = _add.call(this, data, cache, {id, extras});
        const managerName = this.constructor.name;
        const holdName = this.holds?.name
        if (blacklistedManager.includes(managerName) || !holdName) {
            return newData;
        }
        data = newData;

        //console.log(holdName, managerName, '._add', data, cache, id, extras);
        //console.log('new', managerName, '._add', newData, cache, id, extras);
        const collectionName = manager_to_collections[managerName];
        if (collectionName) {
            // add or update
            //const serializer = manager_serializer[managerName];
            const serializer = serialize_anything
            if (typeof serializer !== 'function') {
                throw new Error(`Serializer for ${managerName} not found`);
            }
            const serialized = serializer(data);
            if (serialized) {
                //console.log(managerName, serialized);
                if (serialized.id) {
                    database.collection(collectionName).updateOne({id: serialized.id}, {$set: serialized}, {upsert: true}).catch(ignoreDuplicateErrorHandler);
                } else {
                    database.collection(collectionName).insertOne(serialized).catch(ignoreDuplicateErrorHandler);
                }
            }
        } else {
            if (!logged.includes(managerName)) {
                logged.push(managerName);
                console.log(managerName, '._add', data, cache, id, extras);
                console.log(`No collection found for ${managerName}`);
            }
        }
        return newData;
    }

})


client.on('messageCreate', (message) => {
    if (true) return;
    // log detailed
    console.log(`[${new Date().toLocaleString()}] [${(message.guild?.name || 'DM') + ' - ' + message.channel.name}] ${message.author.tag}: ${message.content}`);
    // check attachments
    if (message.attachments.size > 0) {
        console.log(`[${new Date().toLocaleString()}] [${message.guild ? (message.guild.name + ' - ' + message.channel.name) : 'DM'}] Found ${message.attachments.size} attachments`);
    }

})


const manager_to_collections = {
    MessageManager: 'messages',
    UserManager: 'users',
    PresenceManager: 'presences',
    GuildBanManager: 'bans',
}
const serialize_anything = (object) => {
    const newObject = Object.assign({}, object);
    serialize(newObject);
    return newObject;

}


function serialize(object) {
    //delete anything with object.constructor.name.includes('Manager')
    for (const key in object) {

        if (!object[key]) {
            delete object[key];
        } else if (object[key].size === 0 || object[key].length === 0) {
            delete object[key];
        } else if (Array.isArray(object[key])) {
            //check if obj have id
            if (object[key][0].id) {
                object[key + "_id"] = object[key].map(e => e.id);
                delete object[key];
            } else if (typeof object[key][0] === 'object') {
                //see if deeply nested or just shallow
                let jasoned;
                try {
                    jasoned = JSON.stringify(object[key]);
                    object[key] = JSON.parse(jasoned);
                } catch (e) {
                    delete object[key];
                }
            } else {
                console.log('Array', typeof object[key][0]);
            }

        } else if (object[key].constructor.name.includes('Manager')) {
            delete object[key];
        } else if (object[key].id) {
            object[key + "Id"] = object[key].id;
            delete object[key];
        } else if (typeof object[key] === 'object') {
            //see if deeply nested or just shallow
            let nested = false;
            for (const key2 in object[key]) {
                if (object[key][key2] && typeof object[key][key2] === 'object') {
                    nested = true;
                    break;
                }
            }
            //console.log('nested', nested, object[key]);

            if (nested) {
                delete object[key];
            }

        }
    }
    delete object.client;
    delete object.phoneNumber;
    delete object.emailAddress;
}

const serializer = {
    message: function (message) {
        return {
            _id: message.id,
            guild_id: message.guild?.id,
            channel_id: message.channel.id,
            user_id: message.author.id,
            attachments: message.attachments.map(a => a.url),
            content: message.content,
            timestamp: message.createdTimestamp,
        }
    },
    user: function (user) {
        let newUser = Object.assign({}, user);
        delete newUser._intervalSamsungPresence;
        serialize(newUser);
        return newUser;

    },
    channel: function (channel) {
        let newChannel = Object.assign({}, channel);
        serialize(newChannel);
        return newChannel;
    },
    guild: function (guild) {
        let newGuild = Object.assign({}, guild);
        serialize(newGuild);
        return newGuild;
    }
}
const startTime = Date.now();

async function sleep(number) {
    return new Promise(resolve => setTimeout(resolve, number));
}
//exit on async error
process.on('unhandledRejection', error => {
    console.log('unhandledRejection', error);
    process.exit(1);
});
async function main() {
    await mongoClient.connect();
    //create collection
    const collections = Object.values(manager_to_collections);
    for (const collection of collections) {
        if (!(await database.listCollections({name: collection}).hasNext())) {
            const w = await database.createCollection(collection);
        }
        //check index
        const indexes = await database.collection(collection).indexes();
        if (!indexes.find(i => i.key.id === 1)) {
            await database.collection(collection).createIndex({id: 1}, {unique: true});
        }
    }
    console.log('Connected to MongoDB');
    await client.login(process.env.TOKEN);
    console.log('Logged in');

    const relativeDateFormatter = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
    while (true) {

        const time = Date.now();
        const uptime = time - startTime;
        const uptimeString = relativeDateFormatter.format(-uptime / 1000, 'second');

        await client.user.setPresence({
            activities: [
                {
                    name: `Big Brother is watching you`,
                    type: 'PLAYING',
                    timestamps: {
                        start: startTime,
                    },
                }, {
                    name: `Uptime: ${uptimeString}`,
                    type: 'WATCHING',

                }
            ],
            status: 'idle',
        });
        await sleep((Math.random() * 95000) + 5000);
    }
}

main();
