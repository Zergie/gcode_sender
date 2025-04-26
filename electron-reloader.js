exports.loadPersistent = function (name) {
	if (localStorage.getItem(name)) {
	  const data = JSON.parse(localStorage.getItem(name));
	  console.log(`Loaded ${name} with ${JSON.stringify(data)}`);
	  return data;
	} else {
	  console.log(`Loaded ${name} without persistent data.`);
	  return {} 
	}
};
exports.savePersistent = function (name, data) {
	console.log(`Saved ${name} with ${JSON.stringify(data)}`);
	localStorage.setItem(name, JSON.stringify(data));
};