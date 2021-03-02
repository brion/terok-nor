function collect(instance) {
    const sources = [];
    for (let [name, func] of Object.entries(instance.exports)) {
        sources.push(`const ${name} = ${func.toString()};`);
    }
    return sources.join('\n\n');
}

module.exports = {
    collect
};
