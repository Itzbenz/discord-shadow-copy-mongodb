const Discord = require("discord.js-selfbot-v13");


const avoidGetters = ['deleted', 'editable']
const privacyProperties = ["_id", "me", "meId", "client", "phoneNumber", "emailAddress", "password", "token", "relationships", "mutualFriends"];
//add to avoidGetters
for (const key of privacyProperties) {
    avoidGetters.push(key);
}
const listOfAllGetters = new Set();
const doNotSerialize = ['ClientUser'];

function listGetters(instance) {
    const getters = Object.entries(
        Object.getOwnPropertyDescriptors(
            Reflect.getPrototypeOf(instance)
        )
    )
        //check if function
        .filter(e => typeof e[1].get === 'function' && e[0] !== '__proto__')
        //check if not blacklisted
        .filter(e => !avoidGetters.includes(e[0]))
        //check if not async
        .filter(e => !e[1].get.name.startsWith('async'))
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

        if (object[key] instanceof Discord.Collection) {
            object[key] = object[key].map(e => e);
        }

    }
    //privacy stuff
    for (const key of privacyProperties) {
        delete object[key];
    }
}

module.exports = {
    listGetters,
    isNested,
    scrubbing,
    privacyProperties,
    doNotSerialize,
    listOfAllGetters

}
