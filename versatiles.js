const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const format = require("util").format;
const get = require("./get");
const pkg = require("./package");

const versatiles = module.exports = function versatiles(src, opt) {
	if (!(this instanceof versatiles)) return new versatiles(src, opt);
	const self = this;

	self.opt = {
		tms: false,
		headers: {},
		...(opt||{}),
	};

	self.src = src;
	self.srctype = ["http","https"].includes(src.slice(0,src.indexOf(":"))) ? "http" : "file";

	switch (self.srctype) {
		case "file":
			// global file descriptor
			self.fd = null;
		break;
		case "http":
			// default http(s) request headers
			self.requestheaders = {
				"User-Agent": format("Mozilla/5.0 (compatible; %s/%s; +https://www.npmjs.com/package/%s)", pkg.name, pkg.version, pkg.name),
				...(self.opt.headers||{}),
			};
		break;
	};

	// read queue
	self.readqueue = {};

	// data
	self.header = null;
	self.meta = null;
	self.index = null;
	self.zoom = null;
	self.bbox = null;

	self.formats = {
		"c01": [ "png", "jpeg", "webp", ...Array(13), "pbf" ], // legacy opencloudtiles
		"v01": [ "png", "jpeg", "webp", "pbf" ],
		"v02": [ "bin", ...Array(15), "png", "jpeg", "webp", "avif", "svg", ...Array(11), "pbf", "geojson", "topojson", "json" ],
	};

	self.mimetypes = {
		bin: "application/octet-stream",
		png: "image/png",
		jpeg: "image/jpeg",
		webp: "image/webp",
		avif: "image/avif",
		svg: "image/svg+xml",
		pbf: "application/x-protobuf",
		geojson: "application/geo+json",
		topojson: "application/topo+json",
		json: "application/json",
	};

	self.compression = [ null, "gzip", "br" ];

	return self;
};

// thin wrapper for type specific read function
versatiles.prototype.read = function(position, length, fn){
	const self = this;

	const id = position.toString()+'-'+length.toString;
	if (self.readqueue.hasOwnProperty(id)) return self.readqueue[id].push(fn), self;
	self.readqueue[id] = [ fn ];

	self["read_"+self.srctype](position, length, function(){
		while (self.readqueue[id].length > 0) self.readqueue[id].shift().apply(self, arguments);
		delete self.readqueue[id];
	});

	return self;
};

// read from http(s)
versatiles.prototype.read_http = function(position, length, fn){
	const self = this;

	get({
		url: self.src,
		headers: {
			...self.requestheaders,
			"Range": format("bytes=%s-%s", position.toString(), (BigInt(position)+BigInt(length)-1n).toString()), // explicit .toString() because printf appends 'n' to bigint
		},
		follow: true,
		timeout: 10000,
	}).then(function(resp){

		// check status code
		if (resp.statusCode !== 206) return fn(new Error("Server responded with "+resp.statusCode));

		fn(null, resp.body);
	}).catch(function(err){
		fn(err);
	});

	return self;
};

// read a chunk from a file
versatiles.prototype.read_file = function(position, length, fn){
	const self = this;
	self.open_file(function(err){
		if (err) return fn(err);
		fs.read(self.fd, {
			buffer: Buffer.alloc(Number(length)), // buffer wants integers, but length shouldn't exceed 2^53 anyway
			position: position,
			offset: 0,
			length: Number(length), // fs api does not like bigint here, convert to Number and hope for the best
		}, function(err, r, buf){
			return fn(err, buf);
		});
	});
	return self;
};

// open file once wrapper
versatiles.prototype.open_file = function(fn){
	const self = this;
	if (self.fd !== null) return fn(null), self;
	fs.open(self.src, 'r', function(err, fd){
		if (err) return fn(err);
		self.fd = fd;
		return fn(null);
	});
	return self;
};

// decompression helper
versatiles.prototype.decompress = function(type, data, fn){
	switch (type) {
		case "br": zlib.brotliDecompress(data, fn); break;
		case "gzip": zlib.gunzip(data, fn); break;
		default: fn(null, data); break;
	}
	return this;
};

// get header
versatiles.prototype.getHeader = function(fn){
	const self = this;

	// deliver if known
	if (self.header !== null) return fn(null, { ...self.header }), self;

	self.read(0, 66, function(err, data){
		if (err) return fn(err);

		// check magic bytes
		if (/^versatiles_v0[12]$/.test(data.toString("utf8", 0, 14))) {

			const version = data.toString("utf8", 11, 14);


			switch (version) {
				case "v01":

					try {
						self.header = {
							magic: data.toString("utf8", 0, 14),
							version: version,
							tile_format: self.formats[version][data.readUInt8(14)]||"bin",
							tile_precompression: self.compression[data.readUInt8(15)]||null,
							zoom_min: data.readUInt8(16),
							zoom_max: data.readUInt8(17),
							bbox_min_x: data.readFloatBE(18),
							bbox_min_y: data.readFloatBE(22),
							bbox_max_x: data.readFloatBE(26),
							bbox_max_y: data.readFloatBE(30),
							meta_offset: data.readBigUInt64BE(34),
							meta_length: data.readBigUInt64BE(42),
							block_index_offset: data.readBigUInt64BE(50),
							block_index_length: data.readBigUInt64BE(58),
						};
					} catch (err) {
						return fn(err);
					}

				break;
				case "v02":

					try {
						self.header = {
							magic: data.toString("utf8", 0, 14),
							version: version,
							tile_format: self.formats[version][data.readUInt8(14)]||"bin",
							tile_precompression: self.compression[data.readUInt8(15)]||null,
							zoom_min: data.readUInt8(16),
							zoom_max: data.readUInt8(17),
							bbox_min_x: data.readInt32BE(18) / 10e7,
							bbox_min_y: data.readInt32BE(22) / 10e7,
							bbox_max_x: data.readInt32BE(26) / 10e7,
							bbox_max_y: data.readInt32BE(30) / 10e7,
							meta_offset: data.readBigUInt64BE(34),
							meta_length: data.readBigUInt64BE(42),
							block_index_offset: data.readBigUInt64BE(50),
							block_index_length: data.readBigUInt64BE(58),
						};
					} catch (err) {
						return fn(err);
					}

				break;
				default:
					return fn(new Error("Invalid Container"));
				break;
			}

			// set zoom and bbox if defined
			if (self.header.zoom_mon+self.header.zoom_max > 0) self.zoom = Array(self.header.zoom_max-self.header.zoom_min+1).fill().map(function(v,i){ return i+self.header.zoom_min });
			if (self.header.bbox_min_x+self.header.bbox_max_x+self.header.bbox_min_y+self.header.bbox_may_y > 0) self.bbox = [ self.header.bbox_min_x, self.header.bbox_min_y, self.header.bbox_max_x, self.header.bbox_max_y ];

		} else if (data.toString("utf8", 0, 28) === "OpenCloudTiles-Container-v1:") { // backwards compatibility

			try {
				self.header = {
					magic: data.toString("utf8", 0, 28),
					version: "c01",
					tile_format: self.formats["c01"][data.readUInt8(28)]||"bin",
					tile_precompression: self.compression[data.readUInt8(29)]||null,
					meta_offset: data.readBigUInt64BE(30),
					meta_length: data.readBigUInt64BE(38),
					block_index_offset: data.readBigUInt64BE(46),
					block_index_length: data.readBigUInt64BE(54),
				};
			} catch (err) {
				return fn(err);
			}

		} else {
			return fn(new Error("Invalid Container"));
		}

		fn(null, { ...self.header });

	});

	return self;
};

// get tile by zxy
versatiles.prototype.getTile = function(z, x, y, fn){
	const self = this;

	// when y index is inverted
	if (self.opt.tms) y = Math.pow(2,z)-y-1;

	// ensure block index is loaded
	self.getBlockIndex(function(err){
		if (err) return fn(err);

		// tile xy (within block)
		const tx = x%256;
		const ty = y%256;

		// block xy
		const bx = ((x-tx)/256);
		const by = ((y-ty)/256);

		// check if block containing tile is within bounds
		if (!self.index.hasOwnProperty(z)) return fn(new Error("Invalid Z"));
		if (!self.index[z].hasOwnProperty(bx)) return fn(new Error("Invalid X"));
		if (!self.index[z][bx].hasOwnProperty(by)) return fn(new Error("Invalid Y"));

		const block = self.index[z][bx][by];

		// check if block contains tile
		if (tx < block.col_min || tx > block.col_max) return fn(new Error("Invalid X within Block"));
		if (ty < block.row_min || ty > block.row_max) return fn(new Error("Invalid Y within Block"));

		// calculate sequential tile number
		const j = (ty - block.row_min) * (block.col_max - block.col_min + 1) + (tx - block.col_min);

		// get tile index
		self.getTileIndex(block, function(err){
			if (err) return fn(err);

			const tile_offset = block.tile_index.readBigUInt64BE(12*j) + BigInt(block.block_offset);
			const tile_length = BigInt(block.tile_index.readUInt32BE(12*j+8)); // convert to bigint so range request can be constructed

			// shortcut: return empty buffer
			if (tile_length === 0n) return fn(null, Buffer.allocUnsafe(0));

			self.read(tile_offset, tile_length, function(err, tile){
				if (err) return fn(err);
				return fn(null, tile);
			});


		});

	});

	return self;
};

// get tile index for block
versatiles.prototype.getTileIndex = function(block, fn){
	const self = this;
	if (block.tile_index !== null) return fn(null, block.tile_index), self;
	self.read(block.tile_index_offset, block.tile_index_length, function(err, data){ // read tile_index buffer
		if (err) return fn(err);
		self.decompress("br", data, function(err, data){ // decompress
			if (err) return fn(err);
			block.tile_index = data; // keep as buffer in order to keep heap lean
			return fn(null, block.tile_index);
		});
	});
	return self;
};

// get block index
versatiles.prototype.getBlockIndex = function(fn){
	const self = this;

	// deliver if known
	if (self.index !== null) return fn(null, self.index), self;

	self.getHeader(function(err){
		if (err) return fn(err);

		self.read(self.header.block_index_offset, self.header.block_index_length, function(err, data){ // read block_index buffer
			if (err) return fn(err);
			self.decompress("br", data, function(err, data){ // decompress
				if (err) return fn(err);


				// read index from buffer
				let index = [];

				switch (self.header.version) {
					case "c01":
					case "v01":

						// check blog index length
						if (data.length/29%1 !== 0) return fn(new Error("invalid block index"));

						for (let i = 0; i < (data.length/29); i++) {
							index.push({
								level: data.readUInt8(0+i*29),
								column: data.readUInt32BE(1+i*29),
								row: data.readUInt32BE(5+i*29),
								col_min: data.readUInt8(9+i*29),
								row_min: data.readUInt8(10+i*29),
								col_max: data.readUInt8(11+i*29),
								row_max: data.readUInt8(12+i*29),
								block_offset: 0, // all positions are relative to the whole file
								tile_blobs_length: null, // indeterminable
								tile_index_offset: data.readBigUInt64BE(13+i*29),
								tile_index_length: data.readBigUInt64BE(21+i*29),
								tile_index: null,
							});
						};
					break;
					case "v02":

						// check blog index length
						if (data.length/33%1 !== 0) return fn(new Error("invalid block index"));

						for (let i = 0; i < (data.length/33); i++) {
							index.push({
								level: data.readUInt8(0+i*33),
								column: data.readUInt32BE(1+i*33),
								row: data.readUInt32BE(5+i*33),
								col_min: data.readUInt8(9+i*33),
								row_min: data.readUInt8(10+i*33),
								col_max: data.readUInt8(11+i*33),
								row_max: data.readUInt8(12+i*33),
								block_offset: data.readBigUInt64BE(13+i*33),
								tile_blobs_length: data.readBigUInt64BE(21+i*33),
								tile_index_offset: data.readBigUInt64BE(13+i*33) + data.readBigUInt64BE(21+i*33), // block_offset + tile_blobs_length
								tile_index_length: data.readUInt32BE(29+i*33),
								tile_index: null,
							});
						};
					break;
				};

				// filter invalid blocks and sort by z, y, x
				index = index.filter(function(b){
					return (b.col_max >= b.col_min && b.row_max >= b.row_min); // these shouldn't exist
				}).sort(function(a,b){
					if (a.level !== b.level) return (a.level - b.level);
					if (a.column !== b.column) return (a.column - b.column);
					return (a.row - b.row);
				});

				// build hierarchy
				self.index = index.reduce(function(i,b){
					if (!i.hasOwnProperty(b.level)) i[b.level] = {};
					if (!i[b.level].hasOwnProperty(b.column)) i[b.level][b.column] = {};
					i[b.level][b.column][b.row] = b;
					return i;
				},{});

				return fn(null, self.index);

			});
		});
	});

	return self;
};

// get metadata
versatiles.prototype.getMeta = function(fn){
	const self = this;

	// shortcut: no metadata defined
	if (self.header.meta_length == 0) return fn(null, self.meta = {});

	// deliver if known
	if (self.meta !== null) return fn(null, { ...self.meta }), self;

	self.getHeader(function(err){
		if (err) return fn(err);

		self.read(self.header.meta_offset, self.header.meta_length, function(err, data){ // read meta buffer
			if (err) return fn(err);

			self.decompress(self.header.tile_precompression, data, function(err, data){ // decompress
				if (err) return fn(err);

				try {
					self.meta = JSON.parse(data);
				} catch (err) {
					self.meta = {}; // empty
				}

				return fn(null, { ...self.meta });

			});
		});

	});

	return self;
};

// get zoom levels
versatiles.prototype.getZoomLevels = function(fn){
	const self = this;

	// deliver if known
	if (self.zoom !== null) return fn(null, [ ...self.zoom ]), self;

	self.getBlockIndex(function(err){
		if (err) return fn(err);

		self.zoom = Object.keys(self.index).map(function(z){
			return parseInt(z,10);
		}).sort(function(a,b){
			return a-b;
		});

		return fn(null, [ ...self.zoom ]);

	});

	return self;
};

// get approximate bbox for highest zoom level (lonlat; w, s, e, n)
versatiles.prototype.getBoundingBox = function(fn){
	const self = this;

	// deliver if known
	if (self.bbox !== null) return fn(null, [ ...self.bbox ]), self;

	self.getZoomLevels(function(err, zoom){
		if (err) return fn(err);

		// get max zoom level
		// assumption: highest zoom tileset delivers the most detailed bounding box
		const z = zoom[zoom.length-1];

		// get min and max x
		const xr = Object.keys(self.index[z]).sort(function(a,b){
			return a.localeCompare(b, undefined, { numeric: true });
		});
		const xmin = xr[0];
		const xmax = xr[xr.length-1];

		// get min and max y
		// assumption: extent is the same on every block (tileset is "rectangular")
		const yr = Object.keys(self.index[z][xmin]).sort(function(a,b){
			return a.localeCompare(b, undefined, { numeric: true });
		});

		const ymin = yr[0];
		const ymax = yr[yr.length-1];

		// convert to tile ids;
		let txmin = ((parseInt(xmin,10)*256)+self.index[z][xmin][ymin].col_min);
		let txmax = ((parseInt(xmax,10)*256)+self.index[z][xmin][ymin].col_max+1); // use "next" tile to include all tiles

		let tymin, tymax; // different when invert y
		if (self.opt.tms) { // north → south

			tymin = Math.pow(2,z)-((parseInt(ymin,10)*256)+self.index[z][xmin][ymin].row_min); // use "next" tile, not subtracting 1
			tymax = Math.pow(2,z)-((parseInt(ymax,10)*256)+self.index[z][xmax][ymax].row_max)-1;

		} else { // south → north

			tymin = ((parseInt(ymax,10)*256)+self.index[z][xmax][ymax].row_max)+1; // use "next" tile
			tymax = ((parseInt(ymin,10)*256)+self.index[z][xmin][ymin].row_min);

		};

		// convert to coordinates:
		self.bbox = [
			...self._zxy_ll(z, txmin, tymin),
			...self._zxy_ll(z, txmax, tymax),
		];

		return fn(null, [ ...self.bbox ]);

	});

	return self;
};

// helper zxy → lonlat
versatiles.prototype._zxy_ll = function(z,x,y){
	const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
	return [
		(x / Math.pow(2, z) * 360 - 180), // lon
		(180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))), // lat
	];
};

// create webserver (please don't use this in production)
versatiles.prototype.server = function(){
	const self = this;

	const encodings = {
		gzip: "gzip",
		brotli: "br",
	};

	const url = require("url");

	const srvr = require("http").createServer(function(req, res){

		res.setHeader("Content-type", "text/plain");
		if (req.method !== "GET") return res.statusCode = 405, res.end("Method not allowed");
		const p = url.parse(req.url).pathname;

		// construct base url from request headers
		const baseurl = self.opt.base || format("%s://%s", (req.headers["x-forwarded-proto"] || "http"), (req.headers["x-forwarded-host"] || req.headers.host));

		// output cache
		const cache = {};

		switch (p) {
			case "/":
			case "/index.html":

				// try from cache
				if (cache.html) return res.setHeader("Content-type", "text/html; charset=utf-8"), res.end(cache.html);

				fs.readFile(path.resolve(__dirname,"static/index.html"), function(err, html){
					if (err) return res.statusCode = 500, res.end(err.toString()), console.error(err);
					cache.html = html.toString();
					res.setHeader("Content-type", "text/html; charset=utf-8");
					res.end(cache.html);
				});
			break;
			case "/style.json":

				// try from cache
				if (cache.style) return res.setHeader("Content-type", "application/json; charset=utf-8"), res.end(cache.style);

				// construct style.json
				self.getBoundingBox(function(err, bbox){
					if (err) return res.statusCode = 500, res.end(err.toString()), console.error(err);

					const center = [
						((bbox[0]+bbox[2])/2),
						((bbox[1]+bbox[3])/2)
					];
					self.getZoomLevels(function(err, zoom){
						if (err) return res.statusCode = 500, res.end(err.toString()), console.error(err);

						const zooms = [
							parseInt(zoom[0],10),
							parseInt(zoom[zoom.length-1],10),
						];
						const midzoom = Math.round((zooms[0]+zooms[1])/2);

						const style = {
							version: 8,
							id: "versatiles",
							name: "versatiles",
							zoom: midzoom,
							center: center,
							sources: {},
							layers: [],
						};

						if (self.header.tile_format === "pbf") { // vector tiles
							style.sources.versatiles = {
								type: "vector",
								url: baseurl+"/tile.json",
							};
							// FIXME: extract layers from metadata
						} else { // raster tiles
							style.sources.versatiles = {
								type: "raster",
								tiles: [ baseurl+"/{z}/{x}/{y}" ],
								tileSize: 256,
							};
							style.layers.push({
								id: "versatiles",
								type: "raster",
								source: "versatiles",
								minzoom: zooms[0],
								maxzoom: zooms[1],
							});
						};

						cache.style = JSON.stringify(style,null,"\t");
						res.setHeader("Content-type", "application/json; charset=utf-8");
						return res.end(cache.style);

					});
				});
			break;
			case "/tile.json":

				// try from cache
				if (cache.tilejson) return res.setHeader("Content-type", "application/json; charset=utf-8"), res.end(cache.tilejson);

				// construct tilejson, extend with metadata
				// https://github.com/mapbox/tilejson-spec/tree/master/3.0.0
				self.getMeta(function(err, meta){
					if (err) return res.statusCode = 500, res.end(err.toString()), console.error(err);

					// construct tilejson
					meta.tilejson = "3.0.0";
					meta.tiles = [ baseurl+"/{z}/{x}/{y}" ];
					meta.scheme = meta.scheme || "zxy";

					if (!meta.vector_layers) meta.vector_layers = []; // for good luck!

					self.getBoundingBox(function(err, bbox){
						if (!err) meta.bounds = meta.bounds || bbox;
						self.getZoomLevels(function(err, zoom){
							if (!err) {
								meta.minzoom = meta.minzoom || parseInt(zoom[0],10);
								meta.maxzoom = meta.maxzoom || parseInt(zoom[zoom.length-1],10);
							}

							cache.tilejson = JSON.stringify(meta,null,"\t");
							res.setHeader("Content-type", "application/json; charset=utf-8");
							return res.end(cache.tilejson);

						});
					});
				});
			break;
			default: // get tile (TODO: cache tiles)

				const xyz = p.split("/").filter(function(c){ // this is good enough
					return !!c;
				}).map(function(c){ // getTiles() eats integers
					return parseInt(c,10);
				});
				if (xyz.length < 3) return res.statusCode = 404, res.end("sorry");
				self.getTile(xyz[0], xyz[1], xyz[2], function(err, tile){
					if (err) return res.statusCode = 500, res.end(err.toString()), console.error(err);
					if (tile.length === 0) return res.statusCode = 204, res.end(); // empty tile → "204 no content"
					res.setHeader("Content-type", self.mimetypes[self.header.tile_format]);

					// not compressed anyway
					if (self.header.tile_precompression === null) return res.end(tile);

					// can the client eat the precompression?
					const accepted_encodings = (req.headers["accept-encoding"]||"").split(/, */g).map(function(e){ return e.split(";").shift(); });

					// no, decompression required
					if (accepted_encodings.includes(encodings[self.header.tile_precompression])) return res.setHeader("Content-Encoding", encodings[self.header.tile_precompression]), res.end(tile);

					// decompress and deliver
					self.decompress(self.header.tile_precompression, tile, function(err, tile){
						if (err) return res.statusCode = 500, res.end(err.toString()), console.error(err);
						res.end(tile);
					});

				});
			break;
		}

	});

	srvr.listen.apply(srvr, arguments);

	return srvr;

};

// executable magic
if (require.main === module) {
	if (process.argv.length <3 || process.argv.includes("-h") || process.argv.includes("--help")) return console.error("Usage: versatiles <url|file>.versatiles [--tms] [--port <port>] [--host <hostname|ip>] [--base <http://baseurl/>] [--header-<header-key> <header-value>]"), process.exit(1);
	const src = /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : path.resolve(process.cwd(), process.argv[2]);
	const port = process.argv.includes("--port") ? parseInt(process.argv[process.argv.lastIndexOf("--port")+1],10) : 8080;
	const host = process.argv.includes("--host") ? process.argv[process.argv.lastIndexOf("--host")+1] : "localhost";
	const tms = process.argv.includes("--tms");
	const base = process.argv.includes("--base") ? process.argv[process.argv.lastIndexOf("--base")+1] : null;
	const headers = process.argv.reduce(function(headers, arg, i){
		if (arg.slice(0,9)==="--header-") headers[arg.slice(9)] = process.argv[i+1];
		return headers;
	},{});
	versatiles(src, {
		tms: tms,
		headers: headers,
		base: base,
	}).server(port, host, function(err){
		if (err) return console.error(err.toString()), process.exit(1);
		console.error("Listening on http://%s:%d/", host, port);
	});
};
