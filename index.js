require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
console.log("NODE_ENV: " + process.env.NODE_ENV);
const Discord = require('discord.js-selfbot-v13');
const {Client, RichPresence, Options} = Discord;
require('node:events');
if (process.env.NODE_ENV !== 'production') {
    const longjohn = require('longjohn');
    longjohn.async_trace_limit = -1;
}
const {MongoClient} = require("mongodb");
const mongoClient = new MongoClient(process.env.MONGO_URL, {
    retryWrites: true,
    retryReads: true,
});
const {listGetters, scrubbing, isNested, doNotSerialize} = require('./utils.js');
const database = mongoClient.db(process.env.MONGO_DB);
const EventEmitter = require("node:events");
const {Channel, CachedManager} = require("discord.js-selfbot-v13");

const ignoreDuplicateErrorHandler = (error) => {
    if (error.code === 11000) {
        return;
    }
    throw error;
}
// Hijack and wrap CachedManager _add
// _add(data, cache = true, { id, extras = [] } = {}) {
const _add = CachedManager.prototype._add;
const logged = [];
CachedManager.prototype._add = function (data, cache = true, {id, extras = []} = {}) {
    const existing = this.cache.get(id ?? data.id);
    const newData = _add.call(this, data, cache, {id, extras});
    const clazzName = newData.constructor.name === 'Object' ? data.constructor.name : newData.constructor.name;
    if (!clazzName || (existing && !cache)) {
        return newData;
    }
    const oldData = data;
    data = oldData.id ? oldData : newData


    //console.log(holdName, managerName, '._add', data, cache, id, extras);
    //console.log('new', managerName, '._add', newData, cache, id, extras);
    const collectionName = instanceToCollectionName(newData.constructor.name === 'Object' ? oldData : newData);
    const serialized = serialize(data);
    if (collectionName) {
        // add or update
        //const serializer = manager_serializer[managerName];
        if (serialized) {
            //check if inserting into collection that has index
            const requiredIndex = collectionsIndex[collectionName];
            if (!requiredIndex) {
                console.log(`Missing index for ${collectionName}`);
                return;
            }
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
        if (!logged.includes(clazzName)) {
            logged.push(clazzName);
            console.log(clazzName, '._add', newData, serialized);
            console.log(`No collection found for ${clazzName}`);
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

function instanceToCollectionName(object) {
    //default index are id
    if (object instanceof Discord.GuildMember) {
        return 'members'; // userId, guildId
    } else if (object instanceof Discord.BaseGuild) {
        return 'guilds';
    } else if (object instanceof Discord.Channel) {
        return 'channels';
    } else if (object instanceof Discord.User) {
        return 'users';
    } else if (object instanceof Discord.Message) {
        return 'messages';
    } else if (object instanceof Discord.Presence) {
        return 'presences'; //unindexed
    } else if (object instanceof Discord.Role) {
        return 'roles';
    } else if (object instanceof Discord.Emoji) {
        return 'emojis';
    } else if (object instanceof Discord.GuildBan) {
        return 'bans'; //unindexed
    } else if (object instanceof Discord.BaseGuildEmoji) {
        return 'emojis';
    } else if (object instanceof Discord.GuildScheduledEvent) {
        return 'scheduledEvents';
    } else if (object instanceof Discord.MessageReaction) {
        return 'reactions';
    } else if (object instanceof Discord.Sticker) {
        return 'stickers';
    } else {
        if (object.constructor.name !== 'Object' && object.constructor.name !== 'Array') {
            //console.log(object.constructor.name);
        }
    }
}

const collections = [];
const collectionsIndex = {
    'users': ['id'],
    'messages': ['id'],
    'guilds': ['id'],
    'channels': ['id'],
    'presences': [],
    'bans': [],
    'members': ['userId', 'guildId'],
    'emojis': ['id'],
    'scheduledEvents': ['id'],
    'reactions': [],
    'roles': ['id'],
    'stickers': ['id'],

}

const propNameToCollectionName = {
    'author': 'users',
}
Object.keys(collectionsIndex).forEach(key => {
    if (!collections.includes(key)) {
        collections.push(key);
    }
    propNameToCollectionName[key] = key;
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
        let data = JSON.parse(text);
        if (collectionName) {
            data = serialize(data)
            const requiredIndex = collectionsIndex[collectionName]
            const filter = {};
            //check if all index exists and build filter

            for (const index of requiredIndex) {
                if (!data[index]) {
                    console.error(`Missing index ${index} in ${routeName}`);
                    return;
                }
                filter[index] = data[index];
            }
            //add or update to database
            const ops = data.map(item => ({
                updateOne: {
                    filter: filter,
                },
                update: {$set: item},
                upsert: true
            }));
            database.collection(collectionName).bulkWrite(ops).catch(ignoreDuplicateErrorHandler);
        }

    });

//subscribe to all events
client.on('raw', (packet) => {
    const eventName = packet.t;
    if (!eventName || !packet.d) return
    const data = structuredClone(packet.d);
    //console.log(`[${eventName}]`, data);
    database.collection('events').insertOne({
        eventName,
        data,
        timestamp: Date.now()
    }).catch(ignoreDuplicateErrorHandler);
});
const {exec} = require('child_process');
client.on('update', (oldVersion, newVersion) => {
    if (!newVersion) return;
    if (oldVersion === newVersion) return;
    console.log(`Update from ${oldVersion} to ${newVersion}`);
    const res = exec('npm install discord.js-selfbot-v13');
    res.stdout.on('data', (data) => {
        process.stdout.write(data);
    });
    res.stderr.on('data', (data) => {
        process.stdout.write(data);
    });
    res.on('close', (code) => {
        console.log(`Process exited with code ${code}`);
        if (code === 0) {
            process.exit(0);
        }
    });
});

//hijack client.emit
const emit = client.emit;
client.emit = function (eventName, ...args) {
    //console.log(`[${eventName}]`);
    emit.apply(this, arguments);
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
        console.log(e);
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
                    //let nested = false;

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


//this is insanity
function resolveNested(rootObj) {

    //traverse the tree
    const stack = [{obj: rootObj, prefix: ''}];
    const seen = new Set();
    const ogs = {};
    while (stack.length > 0) {
        const {obj, prefix} = stack.pop();
        scrubbing(obj);
        for (const prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                // Avoid reference sharing
                /**
                 if (obj[prop] instanceof Object && obj[prop].constructor.name !== 'Object' && obj[prop].constructor.name !== 'Array') {
                    const additionals = listGetters(obj[prop]);
                    obj[prop] = obj[prop].clone ? obj[prop].clone() : Object.assign({}, obj[prop]);
                    for (const additional of additionals) {
                        //obj[prop][additional] = obj[prop][additional];
                    }
                }
                 */
                const fullPath = prefix + prop;
                const og = ogs[fullPath] || obj[prop];
                ogs[fullPath] = og;
                let value = obj[prop];
                let markForDeletion = false;
                if (og instanceof Promise) {
                    //really?
                    console.log(`[promise] ${fullPath}`);
                    markForDeletion = true;
                } else if (typeof og === 'object' && value !== null) {
                    let collection = collectionsIndex[prop + 's'] || collectionsIndex[prop] || propNameToCollectionName[prop]
                    if (value.id && !collection) {
                        collection = instanceToCollectionName(value)
                    }
                    if (value.id && collection !== undefined) {
                        obj[prop + "Id"] = value.id;
                        markForDeletion = true;
                    } else if (og instanceof Discord.Application
                        || og instanceof Discord.Client
                        || og instanceof Discord.BaseManager
                        || og instanceof EventEmitter
                    ) {
                        markForDeletion = true;
                    } else {
                        if (seen.has(og)) {
                            if (value.id) {
                                obj[prop + "Id"] = value.id;
                                markForDeletion = true;
                            } else {
                                console.log(`[circular] ${fullPath}`);
                            }
                            //delete obj[prop];
                            continue;
                        }
                        if (!markForDeletion) {
                            seen.add(og);
                            if (typeof obj[prop] === 'object') {
                                //evil object
                                obj[prop] = Object.assign({}, obj[prop]);
                                value = obj[prop];
                            }
                            stack.push({obj: value, prefix: fullPath + '.'});
                        }
                    }
                }

                if (markForDeletion) {
                    delete obj[prop];
                }

            } else {
                //console.log(`${fullPath}: ${value}`);
            }
        }
    }
}

const serializer = {

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
    //check if mongo
    if (error.toString().includes("Mongo") || error.stack.includes("mongo")) {
        //keep it short
        console.err(error.toString());
    } else {
        console.err('unhandledRejection', error);
    }
    process.exit(1);
});


async function main() {
    await mongoClient.connect();
    //create collection
    for (const collection of collections) {
        if (!(await database.listCollections({name: collection}).hasNext())) {
            await database.createCollection(collection);
        }
        //check index
        const indexes = await database.collection(collection).indexes();
        const indexNames = indexes.map(i => i.name);
        const missingIndexes = {};
        for (const index of collectionsIndex[collection]) {
            if (!indexNames.includes(index)) {
                missingIndexes[index] = 1;
            }
        }
        if (Object.keys(missingIndexes).length > 0) {
            await database.collection(collection).createIndex(missingIndexes, {unique: true});
        }
    }
    client.on('error', e => {
        console.error(e);
        process.exit(1);
    });
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

main().then(() => {
    console.log('Done');
});
