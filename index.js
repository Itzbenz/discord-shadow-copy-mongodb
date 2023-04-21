const {Client, Collection, RichPresence} = require('discord.js-selfbot-v13');
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
    throw error;
}
const alreadyIndexed = [];
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
    console.log(`Guild`, guilds.random());
    console.log(`Channel`, channels.random());
    console.log(`User`, users.random());


    // add or update to database
    const guildOps = guilds.map(guild => ({
        updateOne: {
            filter: { id: guild.id },
            update: { $set: serializer.guild(guild) },
            upsert: true
        }
    }));

    const channelOps = channels.map(channel => ({
        updateOne: {
            filter: { id: channel.id },
            update: { $set: serializer.channel(channel) },
            upsert: true
        }
    }));

    const userOps = users.map(user => ({
        updateOne: {
            filter: { id: user.id },
            update: { $set: serializer.user(user) },
            upsert: true
        }
    }));

    await database.collection('guilds').bulkWrite(guildOps);
    await database.collection('channels').bulkWrite(channelOps);
    await database.collection('users').bulkWrite(userOps);


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

                if (serialized.id) {
                    //console.log(managerName, collectionName, serialized.id, serialized);
                    database.collection(collectionName).updateOne({id: serialized.id}, {$set: serialized}, {upsert: true}).catch(ignoreDuplicateErrorHandler);
                } else {
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

})


client.on('messageCreate', (message) => {
    return true;
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
    GuildBanManager: 'bans',
    GuildMemberManager: 'members',
}
const serialize_anything = (object) => {
    return serialize(object);
}

function listGetters(instance) {
    return Object.entries(
        Object.getOwnPropertyDescriptors(
            Reflect.getPrototypeOf(instance)
        )
    )
        .filter(e => typeof e[1].get === 'function' && e[0] !== '__proto__')
        .map(e => e[0]);
}

function serialize(oldObject) {
    let object = Object.assign({}, oldObject);

    //invoke getters that not async
    for (const key of listGetters(oldObject)) {
        try {
            object[key] = oldObject[key];
        } catch (e) {
            //console.log(e);
        }
    }
    //delete anything with object.constructor.name.includes('Manager')
    for (const key in object) {
        if(key.startsWith("_")){
            delete object[key];
            continue;
        }
        if(object[key] instanceof Collection){
            object[key] = object[key].map(e => e);
        }
        if (!object[key]) {
            //if (object[key] === undefined)
                delete object[key];
        } else if (object[key].size === 0 || object[key].length === 0) {
            delete object[key];
        } else if (Array.isArray(object[key])) {
            //check if obj have id
            if(object[key][0] === null || object[key][0] === undefined){
                delete object[key];
            } else if (object[key][0].id) {
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
                //console.log('Array', typeof object[key][0]);
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
    delete object._id;
    delete object.meId;
    delete object.client;
    delete object.phoneNumber;
    delete object.emailAddress;
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
        return serialize(user);

    },
    channel: function (channel) {
        return serialize(channel);
    },
    guild: function (guild) {
        return serialize(guild);
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
    const collectionsIndex = {
        'users': ['id'],
        'messages': ['id'],
        'guilds': ['id'],
        'channels': ['id'],
        'presences': [],
        'bans': [],
        'members': ['userId', 'guildId'],
    }
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
                        .setAssetsLargeText('Big Brother is watching you.'),
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
