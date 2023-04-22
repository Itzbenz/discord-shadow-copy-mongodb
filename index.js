require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
console.log("NODE_ENV: " + process.env.NODE_ENV);
const Discord = require('discord.js-selfbot-v13');
const {Client, Collection, RichPresence, Options, CachedManager} = Discord;
const EventEmitter = require('node:events');
if (process.env.NODE_ENV !== 'production') {
    const longjohn = require('longjohn');
    longjohn.async_trace_limit = -1;
}
const {MongoClient} = require("mongodb");
const mongoClient = new MongoClient(process.env.MONGO_URL, {
    retryWrites: true,
    retryReads: true,
    useNewUrlParser: true,
    useUnifiedTopology: true
});
const database = mongoClient.db(process.env.MONGO_DB);

const ignoreDuplicateErrorHandler = (error) => {
    if (error.code === 11000) {
        return;
    }
    throw error;
}
// Hijack and wrap CachedManager _add
// _add(data, cache = true, { id, extras = [] } = {}) {
const _add = CachedManager.prototype._add;

const blacklistedManager = [
    'GuildEmojiRoleManager', 'GuildEmojiManager', 'GuildStickerManager', 'ReactionManager', 'PermissionOverwriteManager',
    "GuildScheduledEventManager", "RoleManager"];
const logged = [];
CachedManager.prototype._add = function (data, cache = true, {id, extras = []} = {}) {
    const existing = this.cache.get(id ?? data.id);
    const newData = _add.call(this, data, cache, {id, extras});
    const managerName = this.constructor.name;
    const holdName = this.holds?.name
    if (blacklistedManager.includes(managerName) || !holdName || (existing && !cache)) {
        return newData;
    }
    const oldData = data;
    data = oldData.id ? oldData : newData


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
            //check if inserting into collection that has index
            const requiredIndex = collectionsIndex[collectionName];
            let passed = true;
            let filter = {};
            for (const index of requiredIndex) {
                if (!serialized[index]) {
                    //console.log(`Missing index ${index} for ${collectionName}`);
                    passed = false;
                    break;
                }
                filter[index] = serialized[index];
            }
            if (requiredIndex.length > 0 && passed) {

                //console.log(managerName, collectionName, serialized.id, serialized);
                database.collection(collectionName).updateOne({filter},
                    {$set: serialized}, {upsert: true}).catch(ignoreDuplicateErrorHandler);
            } else if (requiredIndex.length === 0) {
                //time series data
                //console.log(managerName, collectionName, serialized);
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


const client = new Client({
    // See other options here
    // https://discordjs-self-v13.netlify.app/#/docs/docs/main/typedef/ClientOptions
    // All partials are loaded automatically
    checkUpdate: false,
    makeCache: Options.cacheEverything(),
});


client.on('ready', async () => {
    console.log(`${client.user.tag} is ready!`);

    //synchronize guilds, channels, users
    const guilds = client.guilds.cache;
    const channels = client.channels.cache;
    const users = client.users.cache;
    console.log(`Guilds: ${guilds.size}`);
    console.log(`Channels: ${channels.size}`);
    console.log(`Users: ${users.size}`);

    //sample
    if (process.env.NODE_ENV !== 'production') {
        console.log(`Guild`, guilds.random());
        console.log(`Channel`, channels.random());
        console.log(`User`, users.random());
    }

    // add or update to database
    const guildOps = guilds.map(guild => ({
        updateOne: {
            filter: {id: guild.id},
            update: {$set: serializer.guild(guild)},
            upsert: true
        }
    }));

    const channelOps = channels.map(channel => ({
        updateOne: {
            filter: {id: channel.id},
            update: {$set: serializer.channel(channel)},
            upsert: true
        }
    }));

    const userOps = users.map(user => ({
        updateOne: {
            filter: {id: user.id},
            update: {$set: serializer.user(user)},
            upsert: true
        }
    }));

    database.collection('guilds').bulkWrite(guildOps).catch(ignoreDuplicateErrorHandler);
    database.collection('channels').bulkWrite(channelOps).catch(ignoreDuplicateErrorHandler);
    database.collection('users').bulkWrite(userOps).catch(ignoreDuplicateErrorHandler);


})


client.on('messageUpdate', (message) => {

});
client.on('messageCreate', (message) => {
    if (true) return;
    // log detailed
    console.log(`[${new Date().toLocaleString()}] [${(message.guild?.name || 'DM') + ' - ' + message.channel.name}] ${message.author.tag}: ${message.content}`);
    // check attachments
    if (message.attachments.size > 0) {
        console.log(`[${new Date().toLocaleString()}] [${message.guild ? (message.guild.name + ' - ' + message.channel.name) : 'DM'}] Found ${message.attachments.size} attachments`);
    }

})

client.on('cacheSweep', (collection, amount) => {
    console.log(`[${new Date().toLocaleString()}] [cacheSweep] ${collection.name} ${amount}`);
})


const manager_to_collections = {
    UserManager: 'users',
    MessageManager: 'messages',
    PresenceManager: 'presences',
    TextChannelManager: 'channels',
    VoiceChannelManager: 'channels',
    CategoryChannelManager: 'channels',
    GuildBanManager: 'bans',
    GuildMemberManager: 'members',
    GuildManager: 'guilds',
}

const apiResponse_to_collections = {
    'GET /users/:id/profile': 'users',
}

client.on('apiResponse',
    /**
     *
     * @param req { Discord.APIRequest }
     * @param res { Discord.Response }
     */
    async (req, res) => {
        console.log(`${req.method.toUpperCase()} ${req.path} ${res.status}`);
        const routeName = `${req.method.toUpperCase()} ${req.route}`
        const collectionName = apiResponse_to_collections[routeName];
        const blob = await res.blob()
        const text = await blob.text();
        const data = JSON.parse(text);
        if (collectionName) {
            //read body
            //console.log(data);
        }

    });

//subscribe to all events
client.on('raw', (packet) => {
    const eventName = packet.t;
    //resolveNested(packet)
    console.log(`[${eventName}]`);
});

const serialize_anything = (object) => {
    return serialize(object);
}

const avoidGetters = ['deleted', 'editable']
const privacyProperties = ["_id", "me", "meId", "client", "phoneNumber", "emailAddress", "password", "token", "relationships", "mutualFriends"];
//add to avoidGetters
for (const key of privacyProperties) {
    avoidGetters.push(key);
}
const listOfAllGetters = new Set();

function listGetters(instance) {
    const getters = Object.entries(
        Object.getOwnPropertyDescriptors(
            Reflect.getPrototypeOf(instance)
        )
    )
        .filter(e => typeof e[1].get === 'function' && e[0] !== '__proto__')
        .filter(e => !avoidGetters.includes(e[0]))
        .map(e => e[0]);

    for (const getter of getters) {
        if (!listOfAllGetters.has(getter)) {
            listOfAllGetters.add(getter);
            //console.log(getter);
        }
    }
    return getters;
}

function isNested(obj) {
    for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === 'object') {
            return true;
        }
    }
    return false;
}

//this is insanity

function resolveNested(rootObj) {

    //traverse the tree
    const stack = [{obj: rootObj, prefix: ''}];
    const seen = new Set();
    while (stack.length > 0) {
        const {obj, prefix} = stack.pop();
        scrubbing(obj);
        for (const prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                // Avoid reference sharing
                const og = obj[prop];
                /*
                if(obj[prop] instanceof Object && obj[prop].constructor.name !== 'Object' && obj[prop].constructor.name !== 'Array'){
                    const additionals = listGetters(obj[prop]);
                    obj[prop] = Object.assign({}, obj[prop]);
                    for (const additional of additionals) {
                        obj[prop][additional] = obj[prop][additional];
                    }
                }

                 */
                const value = obj[prop];
                const fullPath = prefix + prop;

                if (typeof value === 'object' && value !== null) {
                    const collection = manager_to_collections[og.constructor.name + 'Manager'] || (collectionsIndex[prop] ? prop : null);
                    if (value.id && collection) {
                        obj[prop + "Id"] = value.id;
                        delete obj[prop];
                    } else if (og instanceof Discord.Application
                        || og instanceof Discord.Client
                        || og instanceof Discord.BaseManager
                        || og instanceof EventEmitter
                    ) {
                        delete obj[prop];
                    } else {
                        if (seen.has(value)) {
                            if (value.id) {
                                obj[prop + "Id"] = value.id;
                                delete obj[prop];
                            } else {
                                console.log(`[circular] ${fullPath}`);
                            }
                            //delete obj[prop];
                            continue;
                        }
                        seen.add(value);
                        stack.push({obj: value, prefix: fullPath + '.'});
                    }
                } else {
                    //console.log(`${fullPath}: ${value}`);
                }
            }
        }
    }
}

const doNotSerialize = ['ClientUser'];

function scrubbing(object) {
    //scrubbing
    for (const key in object) {

        if (!object[key]) {
            //if (object[key] === undefined)
            delete object[key];
            continue;
        }
        if (key.startsWith("_")) {
            delete object[key];
            continue;
        }
        const className = object[key].constructor.name;
        //do not serialize

        if (doNotSerialize.includes(className)) {
            delete object[key];
            continue;
        }

        if (object[key] instanceof Collection) {
            object[key] = object[key].map(e => e);
        }

    }
    //privacy stuff
    for (const key of privacyProperties) {
        delete object[key];
    }
}

function serialize(oldObject) {
    if (oldObject.toJson) {
        oldObject = oldObject.toJson();
        return oldObject;
    }
    let object = Object.assign({}, oldObject);
    const className = oldObject.constructor.name;

    //do not serialize
    if (doNotSerialize.includes(className)) {
        return;
    }

    //invoke getters that not async
    for (const key of listGetters(oldObject)) {
        try {
            object[key] = oldObject[key];
        } catch (e) {
            //console.log(e);
        }
    }


    //serializing to prevent circular references
    try {
        resolveNested(object);
    } catch (e) {
        scrubbing(object);
        //fallback
        for (const key in object) {

            if (object[key].size === 0 || object[key].length === 0) {
                delete object[key];
            } else if (Array.isArray(object[key])) {
                //check if obj have id
                if (object[key][0] === null || object[key][0] === undefined) {
                    delete object[key];
                } else if (object[key][0].id) {
                    //check if we have collection for it
                    if (collectionsIndex[key]) {
                        object[key + "_id"] = object[key].map(e => e.id);
                        delete object[key];
                    } else {
                        //try to serialize
                        try {
                            object[key] = JSON.parse(JSON.stringify(object[key]));
                        } catch (e) {
                            delete object[key];
                        }
                    }

                } else if (typeof object[key][0] === 'object') {
                    //see if deeply nested or just shallow
                    let nested = false;

                    let jasoned;
                    try {
                        jasoned = JSON.stringify(object[key]);
                        object[key] = JSON.parse(jasoned);
                    } catch (e) {
                        delete object[key];
                    }
                } else {
                    //console.log('Array', typeof object[key][0]);
                }

            } else if (object[key].constructor.name.includes('Manager')) {
                delete object[key];
            } else if (object[key].id) {
                object[key + "Id"] = object[key].id;
                delete object[key];
            } else if (typeof object[key] === 'object') {
                //see if deeply nested or just shallow
                if (isNested(object[key])) {
                    delete object[key];
                }

            }


        }
    }

    return object;
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
        return serialize(user) || {};

    },
    channel: function (channel) {
        return serialize(channel) || {};
    },
    guild: function (guild) {
        return serialize(guild) || {};
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
const collections = Object.values(manager_to_collections);
const collectionsIndex = {
    'users': ['id'],
    'messages': ['id'],
    'guilds': ['id'],
    'channels': ['id'],
    'presences': [],
    'bans': [],
    'members': ['userId', 'guildId'],
}
//add collectionIndex key to collections
Object.keys(collectionsIndex).forEach(key => {
    if (!collections.includes(key)) collections.push(key);
});

async function main() {
    await mongoClient.connect();
    //create collection
    for (const collection of collections) {
        if (!(await database.listCollections({name: collection}).hasNext())) {
            const w = await database.createCollection(collection);
        }
        //check index
        const indexes = await database.collection(collection).indexes();
        const indexNames = indexes.map(i => i.name);
        const indexKeys = indexes.map(i => i.key);
        const missingIndexes = {};
        for (const index of collectionsIndex[collection]) {
            if (!indexNames.includes(index)) {
                missingIndexes[index] = 1;
            }
        }
        if (Object.keys(missingIndexes).length > 0) {

            const w = await database.collection(collection).createIndex(missingIndexes, {unique: true});
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

        if (!process.env.NO_PRESENCE) {
            await client.user.setPresence({
                activities: [
                    new RichPresence()
                        .setName(`Big Brother is watching you`)
                        .setType('PLAYING')
                        .setStartTimestamp(new Date(startTime))
                        .setAssetsLargeImage('https://media.discordapp.net/attachments/1095671418345226290/1098980955139625050/160473d8698840a316a18acd50a3b2b4.png')
                        .setAssetsLargeText('Big Brother is watching you'),
                    {
                        name: `Uptime: ${uptimeString}`,
                        type: 'WATCHING',

                    }
                ],
                status: 'idle',
            });
        }
        console.log(`[${new Date().toLocaleString()}] Uptime: ${uptimeString}`);
        await sleep((Math.random() * 95000) + 5000);
    }
}

main();
