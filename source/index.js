#!/usr/bin/env node

const ASSERT = require("assert");
const PATH = require("path");
const ASYNC = require("async");
const MFS = require("mfs");
const FS = new MFS.FileFS({
    lineinfo: true
});
const Q = require("q");
const QUERYSTRING = require("querystring");
const REQUEST = require("request");
const DIRSUM = require("dirsum");
const CRYPTO = require("crypto");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;
const COLORS = require("colors");
const DOT = require("dot");

COLORS.setTheme({
    error: "red"
});


exports.postdeploy = function(serviceBasePath) {

    var options = {
        force: process.env.PIO_FORCE || false,
        verbose: process.env.PIO_VERBOSE || false,
        debug: process.env.PIO_VERBOSE || process.env.PIO_DEBUG || false,
        silent: process.env.PIO_SILENT || false
    };

    if (options.debug) {
        FS.on("used-path", function(path, method, meta) {
            console.log("[pio.postdeploy] FS." + method, path, "(" + meta.file + " @ " + meta.line + ")");
        });
    }

    var pioConfig = FS.readJsonSync(PATH.join(__dirname, "../.pio.json"));

    var binPath = PATH.join(serviceBasePath, "bin");
	var syncPath = PATH.join(serviceBasePath, "sync");
    var configPath = PATH.join(syncPath, ".pio.json");
//    if (!FS.existsSync(configPath)) {
//        configPath = PATH.join(serviceBasePath, ".pio.json");
//    }
    var livePath = PATH.join(serviceBasePath, "live");
    var preparedBasePath = PATH.join(serviceBasePath, "prepared");
    var builtBasePath = PATH.join(serviceBasePath, "built");
    var deploymentBasePath = PATH.join(serviceBasePath, "configured");

    console.log("[pio.postdeploy]", {
        configPath: configPath,
        syncPath: syncPath,
        livePath: livePath
    });

    function ensurePrerequisites() {
/*
        var activatePath = PATH.join(binPath, "activate.sh");
        if (!FS.existsSync(activatePath)) {
            FS.outputFileSync(activatePath, [
                '#!/bin/sh -e',
                '. /opt/bin/activate.sh'
            ].join("\n"));
        }
*/
        return Q.resolve();
    }

	function scanSync() {
        console.log("[pio.postdeploy] scanSync");

        // TODO: Replace this checksum logic with 1) meta data if available 2) better scanning that does not load files into memory.

        // ----------------
        // @source https://github.com/mcavage/node-dirsum/blob/master/lib/dirsum.js
        // Changes:
        //  * Do not die on non-existent symlink.
        //  * Bugfixes.
        // TODO: Contribute back to author.
        function _summarize(method, hashes) {
          var keys = Object.keys(hashes);
          keys.sort();

          var obj = {};
          obj.files = hashes;
          var hash = CRYPTO.createHash(method);
          for (var i = 0; i < keys.length; i++) {
            if (typeof(hashes[keys[i]]) === 'string') {
              hash.update(hashes[keys[i]]);
            } else if (typeof(hashes[keys[i]]) === 'object') {
              hash.update(hashes[keys[i]].hash);
            } else {
              console.error('Unknown type found in hash: ' + typeof(hashes[keys[i]]));
            }
          }

          obj.hash = hash.digest('hex');
          return obj;
        }

        function digest(root, method, callback) {
          if (!root || typeof(root) !== 'string') {
            throw new TypeError('root is required (string)');
          }
          if (method) {
            if (typeof(method) === 'string') {
              // NO-OP
            } else if (typeof(method) === 'function') {
              callback = method;
              method = 'md5';
            } else {
              throw new TypeError('hash must be a string');
            }
          } else {
            throw new TypeError('callback is required (function)');
          }
          if (!callback) {
            throw new TypeError('callback is required (function)');
          }

          var hashes = {};

          FS.readdir(root, function(err, files) {
            if (err) return callback(err);

            if (files.length === 0) {
              return callback(undefined, {hash: '', files: {}});
            }
            var hashed = 0;
            files.forEach(function(f) {
              var path = root + '/' + f;
              FS.stat(path, function(err, stats) {
                if (err) {
                    if (err.code === "ENOENT") {
                        // We have a symlink that points to target that does not exist.
                        hashes[f] = "na";
                        if (++hashed >= files.length) {
                          return callback(undefined, _summarize(method, hashes));
                        }
                        return;
                    }
                    return callback(err);
                }
                if (stats.isDirectory()) {
                  return digest(path, method, function(err, hash) {
                    if (err) return callback(err);

                    hashes[f] = hash;
                    if (++hashed >= files.length) {
                      return callback(undefined, _summarize(method, hashes));
                    }
                  });
                } else if (stats.isFile()) {
                  FS.readFile(path, 'utf8', function(err, data) {
                    if (err) return callback(err);

                    var hash = CRYPTO.createHash(method);
                    hash.update(data);
                    hashes[f] = hash.digest('hex');

                    if (++hashed >= files.length) {
                      return callback(undefined, _summarize(method, hashes));
                    }
                  });
                } else {
                  console.error('Skipping hash of %s', f);
                  if (++hashed > files.length) {
                    return callback(undefined, _summarize(method, hashes));
                  }
                }
              });
            });
          });
        }
        // ----------------

		return Q.denodeify(function(callback) {
            return digest(PATH.join(syncPath, "source"), "sha1", function (err, sourceHashes) {
                if (err) return callback(err);

    			return digest(PATH.join(syncPath, "scripts"), "sha1", function (err, scriptsHashes) {
    				if (err) return callback(err);

    				return callback(null, {
                        sourceHash: sourceHashes.hash,
                        scriptsHash: scriptsHashes.hash
                    });
    			});
            });
		})();
	}

    // @source http://stackoverflow.com/a/21260087/330439
    function removeOldDirectories (inputDir, keepCount, callback) {
        if (!FS.existsSync(inputDir)) {
            return callback(null);
        }
        return FS.readdir(inputDir, function (err, files) {
            if(err) {
                return callback(err);
            }
            fileNames = files.map(function (fileName) {
                return PATH.join(inputDir, fileName);   
            });
            ASYNC.map(fileNames, function (fileName, cb) {
                return FS.stat(fileName, function (err, stat) {
                    if(err) {
                        return cb(err);
                    };
                    return cb(null, {
                        name: fileName,
                        isDirectory: stat.isDirectory(),
                        time: stat.ctime,
                    });
                });
            }, function (err, files) {
                if(err) {
                    return callback(err);
                };
                files = files.filter(function (file) {
                    return file.isDirectory;
                })
                files.sort(function (filea, fileb) {
                    return filea.time < fileb.time;
                });
                files = files.slice(keepCount);
                ASYNC.map(files, function (file, cb) {
                    return FS.remove(file.name, function (err) {
                        if(err) {
                            if (err.code === "EACCES") {
                                // Ignore for now.
                                // TODO: Escalate permissions?
                                console.log("WARN: Could not delete '" + file.name + "' due to EACCES!");
                                return cb(null, file.name);
                            }
                            return cb(err);
                        };
                        return cb(null, file.name);
                    });
                }, function (err, removedFiles) {
                    if(err) {
                        return callback(err);
                    }
                    return callback(null, removedFiles);
                });
            });
        });
    }

    function scanConfig() {
        console.log("[pio.postdeploy] scanConfig");
        return Q.nbind(FS.readJson, FS)(configPath).then(function(config) {
            var shasum = CRYPTO.createHash("sha1");
            shasum.update(JSON.stringify(config));
            return {
                path: configPath,
                hash: shasum.digest("hex"),
                json: config
            };
        });
    }

    function prepare(preparedPath, configInfo) {
        console.log("[pio.postdeploy] prepare", preparedPath);
        return Q.denodeify(removeOldDirectories)(preparedBasePath, 3).then(function(removed) {
            if (removed) {
                console.log("Removed directories: " + JSON.stringify(removed, null, 4));
            }
            return preparedPath;
        }).then(function () {
            var tmpPath = preparedPath + "~" + Date.now();
            return Q.denodeify(function(callback) {
                function checkExisting(callback) {
                    return FS.exists(preparedPath, function(exists) {
                        if (!exists) {
                            return callback(null, true);
                        }
                        if (process.env.PIO_FORCE) {
                            console.log(("Skipping prepare. Found existing prepare cache at '" + preparedPath + "' BUT CONTINUING due to PIO_FORCE!").yellow);
                            console.log("Removing old prepared path: " + preparedPath);
                            return EXEC('chmod -Rf u+w ' + PATH.basename(preparedPath) + '; rm -Rf ' + PATH.basename(preparedPath), {
                                cwd: PATH.dirname(preparedPath)
                            }, function(err, stdout, stderr) {
                                if (err) return callback(err);
                                return callback(null, true);
                            });
                        } else {
                            console.log(("Skipping prepare. Found existing prepare cache at: " + preparedPath).yellow);
                            return callback(null, false);
                        }
                    });
                }
                return checkExisting(function (err, proceed) {
                    if (err) return callback(err);
                    if (!proceed) {
                        return callback(null, null);
                    }
                    console.log("Preparing ...".magenta);
                    if (!FS.existsSync(PATH.dirname(tmpPath))) {
                        FS.mkdirsSync(PATH.dirname(tmpPath));
                    }
                    return EXEC('cp -Rdf "' + syncPath + '" "' + tmpPath + '"', function(err, stdout, stderr) {
                        if (err) {
                            console.error(stdout);
                            console.error(stderr);
                            return callback(err);
                        }
                        FS.unlinkSync(PATH.join(tmpPath, ".pio.json"));

                        // TODO: Put this into a plugin.
                        function replaceScriptVariables(callback) {
                            console.log("Using http://olado.github.io/doT/ to replace variables in: " + PATH.join(tmpPath, "scripts"));
    // TODO: Need to sanitize before printing!
    //                        console.log("variables", configInfo.json);
                            return Q.denodeify(walk)(PATH.join(tmpPath, "scripts")).then(function(filelist) {
                                function replaceInFile(path) {
                                    return Q.denodeify(function(callback) {
                                        return FS.readFile(PATH.join(tmpPath, "scripts", path), "utf8", function(err, templateSource) {
                                            if (err) return callback(err);
    //                                        console.log("Replacing varibales in: " + PATH.join(tmpPath, "scripts", path));
                                            // TODO: Get own instance: https://github.com/olado/doT/issues/112
                                            DOT.templateSettings.strip = false;
                                            DOT.templateSettings.varname = "service";
                                            var compiled = DOT.template(templateSource);
                                            var result = null;
                                            try {
                                                result = compiled(configInfo.json);
                                            } catch(err) {
                                                return callback(err);
                                            }
                                            FS.chmodSync(PATH.join(tmpPath, "scripts", path), 0744);
                                            return FS.outputFile(PATH.join(tmpPath, "scripts", path), result, "utf8", function(err) {
                                                if (err) return callback(err);                                            
                                                return FS.chmod(PATH.join(tmpPath, "scripts", path), 0544, callback);
                                            });
                                        });
                                    })();
                                }
                                var all = [];
                                filelist.forEach(function(path) {
                                    all.push(replaceInFile(path));   
                                });
                                return Q.all(all);
                            }).then(function() {
                                return callback(null);
                            }).fail(callback);
                        }

                        function prepare(callback) {
                            return FS.exists(PATH.join(tmpPath, "scripts", "prepare.sh"), function(exists) {
                                if (!exists) {
                                    return callback(null);
                                }
                                var proc = SPAWN("sh", [
                                    PATH.join(tmpPath, "scripts", "prepare.sh")
                                ], {
                                    cwd: PATH.join(tmpPath, "source"),
                                    env: {
                                        PATH: PATH.join(__dirname, "node_modules/.bin") + ":" + process.env.PATH,
                                        PIO_CONFIG_PATH: PATH.join(syncPath, ".pio.json"),
                                        PIO_SCRIPTS_PATH: PATH.join(tmpPath, "scripts"),
                                        PIO_SERVICE_PATH: tmpPath,
                                        PIO_FORCE: options.force || false,
                                        PIO_VERBOSE: options.verbose || false,
                                        PIO_DEBUG: options.debug || false,
                                        PIO_SILENT: options.silent || false,
                                        HOME: process.env.HOME
                                    }
                                });
                                proc.stdout.on('data', function (data) {
                                    process.stdout.write(data);
                                });
                                proc.stderr.on('data', function (data) {
                                    process.stderr.write(data);
                                });
                                proc.on('close', function (code) {
                                    if (code !== 0) {
                                        console.error("ERROR: Prepare script exited with code '" + code + "'");
                                        return callback(new Error("Prepare script exited with code '" + code + "'"));
                                    }
                                    return callback(null);
                                });
                            });
                        }

                        return replaceScriptVariables(function(err) {
                            if (err) return callback(err);

                            return prepare(function(err) {
                                if (err) return callback(err);

                                return FS.rename(tmpPath, preparedPath, function(err) {
                                    if (err) return callback(err);

                                    return callback(null, preparedPath);
                                });
                            });
                        });
                    });
                });
            })().fail(function(err) {
                var failedPath = tmpPath + ".failed";
                // TODO: Write our log with failure info tp `failedPath + '/.pio/error'
                if (FS.existsSync(tmpPath)) {
                    FS.renameSync(tmpPath, failedPath);
                }
                console.log("Prepare Failed! Moving failed prepare to: " + failedPath);
                throw err;
            });
        });
    }

	function build(preparedPath, builtPath, syncInfo, configInfo) {
        console.log("[pio.postdeploy] build", preparedPath, builtPath);
        return Q.denodeify(removeOldDirectories)(builtBasePath, 3).then(function(removed) {
            if (removed) {
                console.log("Removed directories: " + JSON.stringify(removed, null, 4));
            }
            return builtPath;
        }).then(function () {    
            var tmpPath = builtPath;// + "~" + Date.now();
            return Q.denodeify(function(callback) {
                function checkExisting(callback) {
                    return FS.exists(builtPath, function(exists) {
                        if (!exists) {
                            return callback(null, true);
                        }
                        if (process.env.PIO_FORCE) {
                            console.log(("Skipping install. Found existing built cache at '" + builtPath + "' BUT CONTINUING due to PIO_FORCE!").yellow);
                            console.log("Removing old build path: " + builtPath);
                            return EXEC('chmod -Rf u+w ' + PATH.basename(builtPath) + '; rm -Rf ' + PATH.basename(builtPath), {
                                cwd: PATH.dirname(builtPath)
                            }, function(err, stdout, stderr) {
                                if (err) return callback(err);
                                return callback(null, true);
                            });
                        } else {
                            return FS.exists(PATH.join(builtPath, ".success"), function (exists) {
                                if (exists) {
                                    console.log(("Skipping install. Found existing built cache at: " + builtPath).yellow);
                                    return callback(null, false);
                                }
                                console.log(("Found existing built cache at '" + builtPath + "' but no success flag. So we remove old build and rebuild.").yellow);
                                return EXEC('chmod -Rf u+w ' + PATH.basename(builtPath) + '; rm -Rf ' + PATH.basename(builtPath), {
                                    cwd: PATH.dirname(builtPath)
                                }, function(err, stdout, stderr) {
                                    if (err) return callback(err);
                                    return callback(null, true);
                                });
                            });
                        }
                    });
                }
                return checkExisting(function(err, proceed) {
                    if (err) return callback(err);
                    if (!proceed) {
                        return callback(null, null);
                    }

                    ASSERT.equal(typeof configInfo.json.config.pio.serviceRepositoryUri, "string");
                    ASSERT.equal(typeof configInfo.json.config["pio.service"].id, "string");

                    function onlyBestAspects(aspects) {
                        var best = {};
                        for (var name1 in aspects) {
                            var m1 = name1.match(/^([^\[]+)(:?\[([^\]]+)\])?$/);
                            if (m1) {
                                if (!best[m1[1]]) {
                                    // We pick the first aspect with matching query.
                                    for (var name2 in aspects) {
                                        var m2 = name2.match(/^([^\[]+)\[([^\]]+)\]$/);
                                        if (m2) {
                                            var qs = QUERYSTRING.parse(m2[2]);
                                            var ok = true;
                                            for (var key in qs) {
                                                if (process[key] !== qs[key]) {
                                                    ok = false;
                                                }
                                            }
                                            if (ok) {
                                                best[m1[1]] = aspects[name2];
                                                break;
                                            }
                                        }
                                    }
                                    // If no aspects with matching query found we return default.
                                    if (aspects[m1[1]]) {
                                        best[m1[1]] = aspects[m1[1]];
                                    }
                                }
                            } else {
                                console.error("Warning: ignoring aspect '" + name1 + "' due to malformed syntax!");
                            }
                        }
                        return best;
                    }

                    var cacheUri = null;
                    if (configInfo.json.config && configInfo.json.config["smi.cli"] && configInfo.json.config["smi.cli"].aspects) {
                        var aspects = onlyBestAspects(configInfo.json.config["smi.cli"].aspects);
                        if (aspects["build"]) {
                            cacheUri = aspects["build"];
                        }
                    }

                    var archivePath = PATH.join(tmpPath, PATH.basename(cacheUri));

                    function checkInstallCache(callback) {
                        if (!cacheUri) {
                            return callback(null, false);
                        }
                        if (process.env.PIO_BUILD_CACHE === "false") {
                            console.log(("Skip downloading existing build from '" + cacheUri + "' due to PIO_BUILD_CACHE === false!").yellow);
                            return callback(null, false);
                        }
//                        if (process.env.PIO_FORCE) {
                            if (configInfo.json.config["smi.cli"].syncInfo) {
                                if (
                                    configInfo.json.config["smi.cli"].syncInfo.sourceHash === syncInfo.sourceHash &&
                                    configInfo.json.config["smi.cli"].syncInfo.scriptsHash === syncInfo.scriptsHash
                                ) {
                                    console.log(("Source and script hashes same as catalog!").yellow);
                                } else {
                                    console.log("catalog/local sync info", "sourceHash", configInfo.json.config["smi.cli"].syncInfo.sourceHash, syncInfo.sourceHash);
                                    console.log("catalog/local sync info", "scriptsHash", configInfo.json.config["smi.cli"].syncInfo.scriptsHash, syncInfo.scriptsHash);
                                    console.log(("Skip downloading existing build from '" + cacheUri + "' as source and script hashes not same as catalog!").yellow);
                                    return callback(null, false);
                                }
                            } else {
                                console.log("Warning: No syncInfo in remote config!");
                            }
//                        }
                        if (
                            configInfo.json.config["pio.service"].config &&
                            configInfo.json.config["pio.service"].config["smi.cli"] &&
                            configInfo.json.config["pio.service"].config["smi.cli"].finalChecksum &&
                            configInfo.json.config["pio.service"].config.finalChecksum
                        ) {
                            // TODO: Don't use the checksum calculated on deploy as it does not change when
                            //       individual files are synced up. We need to calculate our own checksum based on what is in the sync folder.
                            if (configInfo.json.config["pio.service"].config.finalChecksum !== configInfo.json.config["pio.service"].config["smi.cli"].finalChecksum) {
                                console.log(("Skip downloading existing build from '" + cacheUri + "'. finalChecksum does not match!").yellow);
                                return callback(null, false);
                            }
                            console.log("Final checksum match:", configInfo.json.config["pio.service"].config.finalChecksum);
                        }

                        function download(callback) {

                            console.log(("Downloading existing build from '" + cacheUri + "'!").magenta);

                            if (!FS.existsSync(PATH.dirname(archivePath))) {
                                FS.mkdirsSync(PATH.dirname(archivePath));
                            }

                            var tmpPath = archivePath + "~" + Date.now();

                            var proc = SPAWN("wget", [
                                "--progress=bar:force",
                                "-O", tmpPath,
                                cacheUri
                            ], {
                                cwd: PATH.dirname(tmpPath)
                            });
                            proc.stdout.on('data', function (data) {
                                process.stdout.write(data);
                            });
                            proc.stderr.on('data', function (data) {
                                process.stderr.write(data);
                            });
                            proc.on('close', function (code) {
                                if (code !== 0) {

                                    // TODO: Is this correct?
                                    if (code === 8) {  // Not found.
                                        // TODO: Optionally skip download and compile from source?
                                        var err = new Error("Error: Got status '404' while downloading '" + cacheUri + "'");
                                        err.code = 404;
                                        return callback(err);
                                    }

                                    console.error("ERROR: Download of '" + cacheUri + "' failed with code '" + code + "'");
                                    // TODO: Optionally skip download and compile from source?
                                    return callback(new Error("Download of '" + cacheUri + "' failed with code '" + code + "'"));
                                }

                                console.log(("Successfully downloaded existing build from '" + cacheUri + "' to '" + archivePath + "'").green);
                                return FS.rename(tmpPath, archivePath, function(err) {
                                    if (err) return callback(err);
                                    return callback(null, archivePath);
                                });
                            });
                        }

                        return download(function(err, downloadedArchivePath) {
                            if (err) {
                                if (err.code === 404) {
                                    // We can ignore a missing archive as we can build from source.
                                    console.log("Warning: Ignoring missing archive cache error '" + err.message + "' as we can build from source.");
                                    return callback(null, false);
                                }
                                return callback(err);
                            }
                            if (downloadedArchivePath) {
                                console.log("Extract '" + archivePath + "' to '" + PATH.join(tmpPath, "build") + "'");
                                FS.mkdirsSync(PATH.join(tmpPath, "build"));
                                return EXEC('tar -xzf "' + PATH.basename(archivePath) + '" --strip 1 -C "' + PATH.join(tmpPath, "build") + '"', {
                                    cwd: PATH.dirname(archivePath)
                                }, function(err, stdout, stderr) {
                                    if (err) {
                                        console.log("Removing: " + archivePath)
                                        return FS.remove(archivePath, function(err) {
                                            if (err) {
                                                console.error(err.stack);
                                            }
                                            process.stderr.write(stdout);
                                            process.stderr.write(stderr);
                                            return callback(err);
                                        });
                                    }
                                    console.log("Archive extracted to: " + PATH.join(tmpPath, "build"));
                                    return callback(null, true);
                                });
                            }
                            return callback(null, false);
                        });
                    }

                    return checkInstallCache(function(err, installCacheExists) {
                        if (err) return callback(err);
                        FS.outputFileSync(PATH.join(tmpPath, "bin/activate.sh"), [
                            '#!/bin/sh -e',
                            '. /opt/bin/activate.sh'
                        ].join("\n"));

                        console.log("Linking '" + PATH.join(preparedPath, "source") + "' to '" + PATH.join(tmpPath, "source") + "'");
                        FS.symlinkSync(PATH.relative(PATH.join(tmpPath), PATH.join(preparedPath, "source")), PATH.join(tmpPath, "source"));
                        if (!FS.existsSync(PATH.join(tmpPath, "bin"))) {
                            FS.mkdirsSync(PATH.join(tmpPath, "bin"));
                        }

                        // Removing downloaded archive to save disk space.
                        if (FS.existsSync(archivePath)) {
                            console.log("Removing '" + archivePath + "' to save disk space");
                            FS.removeSync(archivePath);
                        }

                        if (installCacheExists) {

                            FS.chmodSync(PATH.join(tmpPath, "build"), 0744);

                            return FS.exists(PATH.join(preparedPath, "scripts", "rebuild.sh"), function (exists) {
                                if (!exists) {
                                    console.log("Skip Re-install as no reinstall script found. Using built cache: " + builtPath);

                                    return FS.outputFile(PATH.join(builtPath, ".success"), "", "utf8", function(err) {
                                        if (err) return callback(err);
            //                        return FS.rename(tmpPath, builtPath, function(err) {
            //                            if (err) return callback(err);
                                        return callback(null, builtPath);
            //                        });
                                    });
                                }

                                console.log("Re-installing ...".magenta);

                                var execEnv = {};
                                for (var name in configInfo.json.env) {
                                    execEnv[name] = configInfo.json.env[name];
                                }
                                execEnv.PATH = PATH.join(__dirname, "node_modules/.bin") + ":" + process.env.PATH;
                                execEnv.PIO_CONFIG_PATH = PATH.join(syncPath, ".pio.json");
                                execEnv.PIO_SERVICE_PATH = tmpPath;
                                execEnv.PIO_SCRIPTS_PATH = PATH.join(preparedPath, "scripts");
                                execEnv.PIO_FORCE = options.force || false;
                                execEnv.PIO_VERBOSE = options.verbose || false;
                                execEnv.PIO_DEBUG = options.debug || false;
                                execEnv.PIO_SILENT = options.silent || false;
                                execEnv.HOME = process.env.HOME;

                                var proc = SPAWN("sh", [
                                    PATH.join(preparedPath, "scripts", "rebuild.sh")
                                ], {
                                    cwd: PATH.join(tmpPath, "build"),
                                    env: execEnv
                                });
                                proc.stdout.on('data', function (data) {
                                    process.stdout.write(data);
                                });
                                proc.stderr.on('data', function (data) {
                                    process.stderr.write(data);
                                });
                                proc.on('close', function (code) {
                                    if (code !== 0) {
                                        console.error("ERROR: Install script exited with code '" + code + "'");
                                        return callback(new Error("Install script exited with code '" + code + "'"));
                                    }
                                    return FS.outputFile(PATH.join(builtPath, ".success"), "", "utf8", function(err) {
                                        if (err) return callback(err);
            //                            return FS.rename(tmpPath, builtPath, function(err) {
            //                                if (err) return callback(err);
                                            return callback(null, builtPath);
            //                            });
                                    });
                                });
                            });
                        }

                        console.log("Installing ...".magenta);
                        if (!FS.existsSync(tmpPath)) {
                            FS.mkdirsSync(tmpPath);
                        }
                        return EXEC('cp -Rdf "' + PATH.join(preparedPath, "source") + '" "' + PATH.join(tmpPath, "build") + '"', function(err, stdout, stderr) {
                            if (err) {
                                console.error(stdout);
                                console.error(stderr);
                                return callback(err);
                            }
                            FS.chmodSync(PATH.join(tmpPath, "build"), 0744);

                            var execEnv = {};
                            for (var name in configInfo.json.env) {
                                execEnv[name] = configInfo.json.env[name];
                            }
                            execEnv.PATH = PATH.join(__dirname, "node_modules/.bin") + ":" + process.env.PATH;
                            execEnv.PIO_CONFIG_PATH = PATH.join(syncPath, ".pio.json");
                            execEnv.PIO_SERVICE_PATH = tmpPath;
                            execEnv.PIO_SCRIPTS_PATH = PATH.join(preparedPath, "scripts");
                            execEnv.PIO_FORCE = options.force || false;
                            execEnv.PIO_VERBOSE = options.verbose || false;
                            execEnv.PIO_DEBUG = options.debug || false;
                            execEnv.PIO_SILENT = options.silent || false;
                            execEnv.HOME = process.env.HOME;

                            var proc = SPAWN("sh", [
                                PATH.join(preparedPath, "scripts", "build.sh")
                            ], {
                                cwd: PATH.join(tmpPath, "build"),
                                env: execEnv
                            });
                            proc.stdout.on('data', function (data) {
                                process.stdout.write(data);
                            });
                            proc.stderr.on('data', function (data) {
                                process.stderr.write(data);
                            });
                            proc.on('close', function (code) {
                                if (code !== 0) {
                                    console.error("ERROR: Install script exited with code '" + code + "'");
                                    return callback(new Error("Install script exited with code '" + code + "'"));
                                }
                                return FS.outputFile(PATH.join(builtPath, ".success"), "", "utf8", function(err) {
                                    if (err) return callback(err);
        //                            return FS.rename(tmpPath, builtPath, function(err) {
        //                                if (err) return callback(err);
                                        return callback(null, builtPath);
        //                            });
                                });
                            });
                        });
                    });
                });
            })().fail(function(err) {
                var failedPath = tmpPath + ".failed~" + Date.now();
                // TODO: Write our log with failure info tp `failedPath + '/.pio/error'
                if (FS.existsSync(tmpPath)) {
                    FS.renameSync(tmpPath, failedPath);
                }
                console.log("Build Failed! Moving failed build to: " + failedPath);
                throw err;
            });
        });
	}

    function configure(preparedPath, builtPath, deploymentPath, configInfo, syncInfo) {
        console.log("[pio.postdeploy] configure", preparedPath, builtPath, deploymentPath);
        var tmpPath = deploymentPath; // + "~" + Date.now();
        return Q.denodeify(removeOldDirectories)(deploymentBasePath, 3).then(function(removed) {
            if (removed) {
                console.log("Removed directories: " + JSON.stringify(removed, null, 4));
            }
        }).then(function() {
            return Q.denodeify(function(callback) {
                function checkExisting(callback) {
                    return FS.exists(deploymentPath, function(exists) {
                        if (!exists) {
                            return callback(null, true);
                        }
                        if (process.env.PIO_FORCE) {
                            console.log(("Skipping configure. Found existing configured cache at '" + deploymentPath + "' BUT CONTINUING due to PIO_FORCE!").yellow);
                            console.log("Removing old deployment path: " + deploymentPath);
                            return EXEC('chmod -Rf u+w ' + PATH.basename(deploymentPath) + '; rm -Rf ' + PATH.basename(deploymentPath), {
                                cwd: PATH.dirname(deploymentPath)
                            }, function(err, stdout, stderr) {
                                if (err) return callback(err);
                                return callback(null, true);
                            });
                        } else {
                            console.log(("Skipping configure. Found existing configured cache at: " + deploymentPath).yellow);
                            return callback(null, false);
                        }
                    });
                }
                return checkExisting(function(err, proceed) {
                    if (err) return callback(err);
                    if (!proceed) {
                        return callback(null, null);
                    }
                    console.log("Configuring ...".magenta);
                    FS.mkdirsSync(PATH.dirname(tmpPath));
                    return EXEC('cp -Rdf "' + builtPath + '" "' + tmpPath + '"', function(err, stdout, stderr) {
                        if (err) {
                            console.error(stdout);
                            console.error(stderr);
                            return callback(err);
                        }

                        var execEnv = {};
                        var lines = [
                            '#!/bin/sh -e',
                            '. /opt/bin/activate.sh',
                        ];
                        for (var name in configInfo.json.env) {
                            lines.push('export ' + name + '=' + configInfo.json.env[name]);
                            execEnv[name] = configInfo.json.env[name];
                        }
                        if (typeof execEnv.PORT === "undefined") {
                            lines.push('export PORT=""');
                            execEnv.PORT = "";
                        }
                        ASSERT.equal(typeof configInfo.json.env.PATH, "string");
                        lines.push('export PATH=' + PATH.join(tmpPath.replace(/~\d+$/, ""), "bin") + ':' + configInfo.json.env.PATH);
    //console.log("final activate lines", lines);
                        FS.outputFileSync(PATH.join(tmpPath, "bin/activate.sh"), lines.join("\n"));

                        configInfo.json.config["pio.service"].syncInfo = syncInfo;

                        FS.outputFileSync(PATH.join(tmpPath, ".pio.json"), JSON.stringify(configInfo.json, null, 4));
                        //return FS.copy(configPath, PATH.join(tmpPath, PATH.basename(configPath)), function(err) {
                        //    if (err) return callback(err);

                            return EXEC('cp -Rdf "' + PATH.join(preparedPath, "scripts") + '" "' + PATH.join(tmpPath, "scripts") + '"', function(err, stdout, stderr) {
                                if (err) {
                                    console.error(stdout);
                                    console.error(stderr);
                                    return callback(err);
                                }
                                var commands = [
                                    'cp -Rdf "' + PATH.join(tmpPath, "build") + '" "' + PATH.join(tmpPath, "install") + '"',
                                    // NOTE: When deploying as root we need to give the group write access to allow other processes to access the files.
                                    // TODO: Narrow down file access by using different users and groups for different services depending on their relationships.
                                    'chmod -Rf g+wx "' + PATH.join(tmpPath, "install") + '"'
                                ];
                                return EXEC(commands.join(";"), function(err, stdout, stderr) {
                                    if (err) {
                                        console.error(stdout);
                                        console.error(stderr);
                                        return callback(err);
                                    }

                                    function configure(callback) {
                                        return FS.exists(PATH.join(tmpPath, "scripts", "configure.sh"), function(exists) {
                                            if (!exists) {
                                                return callback(null);
                                            }
                                            execEnv.PATH = PATH.join(__dirname, "node_modules/.bin") + ":" + execEnv.PATH.replace("$PATH", process.env.PATH);
                                            execEnv.PIO_CONFIG_PATH = PATH.join(tmpPath, PATH.basename(configPath));
                                            execEnv.PIO_SCRIPTS_PATH = PATH.join(tmpPath, "scripts");
                                            execEnv.PIO_SERVICE_PATH = tmpPath;
                                            execEnv.PIO_BUILT_PATH = builtPath;
                                            execEnv.PIO_FORCE = options.force || false;
                                            execEnv.PIO_VERBOSE = options.verbose || false;
                                            execEnv.PIO_DEBUG = options.debug || false;
                                            execEnv.PIO_SILENT = options.silent || false;
                                            execEnv.HOME = process.env.HOME;
    //console.log("configure execEnv", execEnv);
                                            var proc = SPAWN("sh", [
                                                PATH.join(tmpPath, "scripts", "configure.sh")
                                            ], {
                                                cwd: PATH.join(tmpPath, "install"),
                                                env: execEnv
                                            });
                                            proc.stdout.on('data', function (data) {
                                                process.stdout.write(data);
                                            });
                                            proc.stderr.on('data', function (data) {
                                                process.stderr.write(data);
                                            });
                                            proc.on('close', function (code) {
                                                if (code !== 0) {
                                                    console.error("ERROR: Configure script exited with code '" + code + "'");
                                                    return callback(new Error("Configure script exited with code '" + code + "'"));
                                                }
                                                return callback(null);
                                            });
                                        });
                                    }

                                    return configure(function(err) {
                                        if (err) return callback(err);

                                        function linkCommands() {
                                            var all = [];
                                            if (
                                                configInfo.json.config["pio.service"].sourceDescriptor &&
                                                configInfo.json.config["pio.service"].sourceDescriptor.bin
                                            ) {
                                                for (var name in configInfo.json.config["pio.service"].sourceDescriptor.bin) {
                                                    all.push(Q.denodeify(function(name, callback) {
                                                        var linkPath = PATH.join(tmpPath, "bin", name);
                                                        try {
                                                            FS.unlinkSync(linkPath);
                                                        } catch(err) {
                                                            if (err.code !== "ENOENT") {
                                                                return callback(err);
                                                            }
                                                        }
                                                        try {
                                                            var commandPath = PATH.join(tmpPath, "install", configInfo.json.config["pio.service"].sourceDescriptor.bin[name]);
                                                            console.log("Linking " + commandPath + " to " + linkPath);
                                                            FS.symlinkSync(PATH.relative(PATH.dirname(linkPath), commandPath), linkPath);
                                                            return callback(null);
                                                        } catch(err) {
                                                            return callback(err);
                                                        }
                                                    })(name));
                                                }
                                            }
                                            return Q.all(all);                                    
                                        }

                                        return linkCommands().then(function() {

            //                            return FS.rename(tmpPath, deploymentPath, function(err) {
            //                                if (err) return callback(err);
                                            return callback(null, deploymentPath);
            //                            });
                                        }).fail(callback);
                                    });
                                });
                            });
                        //});
                    });
                });
            })().fail(function(err) {
                var failedPath = tmpPath + ".failed";
                // TODO: Write our log with failure info tp `failedPath + '/.pio/error'
                FS.renameSync(tmpPath, failedPath);
                console.log("Configure Failed! Moving failed deployment to: " + failedPath);
                throw err;
            });
        });
    }

    function run(deploymentPath, configInfo) {
        console.log("[pio.postdeploy] run", deploymentPath);
        return Q.fcall(function() {
            console.log(("Taking live '" + deploymentPath + "' by linking to '" + livePath + "'").magenta);
            // Take sevice live.
            try {
                FS.unlinkSync(livePath);
            } catch(err) {
                if (err.code !== "ENOENT") {
                    throw err;
                }
            }            
            FS.symlinkSync(PATH.relative(PATH.dirname(livePath), deploymentPath), livePath);
        }).then(function() {
            return Q.denodeify(function(callback) {
                console.log(("Running ... (PIO_CONFIG_PATH: " + PATH.join(livePath, ".pio.json") + ")").magenta);

                var execEnv = {};
                for (var name in configInfo.json.env) {
                    execEnv[name] = configInfo.json.env[name];
                }
                execEnv.PATH = PATH.join(livePath, "bin") + ":" + process.env.PATH;
                execEnv.PIO_CONFIG_PATH = PATH.join(livePath, ".pio.json");
                execEnv.PIO_SERVICE_PATH = livePath;
                execEnv.PIO_SCRIPTS_PATH = PATH.join(livePath, "scripts");
                execEnv.PIO_FORCE = options.force || false;
                execEnv.PIO_VERBOSE = options.verbose || false;
                execEnv.PIO_DEBUG = options.debug || false;
                execEnv.PIO_SILENT = options.silent || false;
                execEnv.HOME = process.env.HOME;

                var proc = SPAWN("sh", [
                    PATH.join(livePath, "scripts", "run.sh")
                ], {
                    cwd: PATH.join(livePath, "install"),
                    env: execEnv
                });
                proc.stdout.on('data', function (data) {
                    process.stdout.write(data);
                });
                proc.stderr.on('data', function (data) {
                    process.stderr.write(data);
                });
                proc.on('close', function (code) {
                    if (code !== 0) {
                        console.error("ERROR: Run script exited with code '" + code + "'");
                        return callback(new Error("Run script exited with code '" + code + "'"));
                    }
                    return callback(null, livePath);
                });
            })().fail(function(err) {
                console.log("Run Failed!");
                throw err;
            }).then(function() {            
                // Link all service-local commands that are declared in the service descriptor into the global PATH.
                var all = [];
                if (configInfo.json.config["pio.service"].descriptor && configInfo.json.config["pio.service"].descriptor.bin) {
                    for (var name in configInfo.json.config["pio.service"].descriptor.bin) {
                        all.push(Q.denodeify(function(name, callback) {
                            var linkPath = PATH.join(configInfo.json.config["pio.vm"].prefixPath, "bin", name);
                            try {
                                FS.unlinkSync(linkPath);
                            } catch(err) {
                                if (err.code !== "ENOENT") {
                                    return callback(err);
                                }
                            }
                            try {
                                var commandPath = PATH.join(livePath, configInfo.json.config["pio.service"].descriptor.bin[name]);
                                console.log("Linking " + commandPath + " to " + linkPath);
                                FS.symlinkSync(PATH.relative(PATH.dirname(linkPath), commandPath), linkPath);
                                return callback(null);
                            } catch(err) {
                                return callback(err);
                            }
                        })(name));
                    }
                }
                return Q.all(all);
            });
        }).then(function() {
            // TODO: This should be done via a PINF abstraction.
            var descriptor = {
                "config": {
                    "pio.service": {
                        "basePath": serviceBasePath,
                        "aspects": {
                            "source": {
                                "basePath": PATH.join(serviceBasePath, "live/source")
                            },
                            "scripts": {
                                "basePath": PATH.join(serviceBasePath, "live/scripts")
                            },
                            "install": {
                                "basePath": PATH.join(serviceBasePath, "live/install")
                            }
                        }
                    },
                    "smi.cli": {
                        "aspects": {
                            "install": {
                                "basePath": PATH.join(serviceBasePath, "live/install")
                            }
                        }
                    }
                }
            };
            if (
                configInfo.json.config["pio.service"].sourceDescriptor &&
                configInfo.json.config["pio.service"].sourceDescriptor["config.plugin"]
            ) {
                descriptor["config.plugin"] = configInfo.json.config["pio.service"].sourceDescriptor["config.plugin"];
            }        
            FS.outputFileSync(PATH.join(serviceBasePath, "package.json"), JSON.stringify(descriptor, null, 4));
        });
    }

    return ensurePrerequisites().then(function() {

    	return scanSync().then(function(syncInfo) {

            return scanConfig().then(function(configInfo) {

                // TODO: Calculate prepared hash instead of re-using finalChecksum.
                var preparedPath = PATH.join(preparedBasePath, configInfo.json.config["pio.service"].finalChecksum + "-" + configInfo.json.config["pio.service"].finalChecksum);
                var builtPath = PATH.join(builtBasePath, configInfo.json.config["pio.service"].finalChecksum + "-" + configInfo.json.config["pio.service"].finalChecksum);

                return prepare(preparedPath, configInfo).then(function() {

                    console.log("Using prepared path: " + preparedPath);

                    return build(preparedPath, builtPath, syncInfo, configInfo).then(function() {

                        console.log("Using built path: " + builtPath);
/*
                        var shasum = CRYPTO.createHash("sha1");
                        shasum.update(syncInfo.sourceHash + ":" + syncInfo.scriptsHash + ":" + configInfo.hash);
                        var deploymentPath = PATH.join(deploymentBasePath, shasum.digest("hex"));
*/
                        var deploymentPath = PATH.join(deploymentBasePath, configInfo.json.config["pio.service"].finalChecksum + "-" + configInfo.json.config["pio.service"].finalChecksum + "-" + configInfo.hash);
                        console.log("Using deployment path: " + deploymentPath);

                        return configure(preparedPath, builtPath, deploymentPath, configInfo, syncInfo).then(function() {

                            return run(deploymentPath, configInfo);
                        });
                    });
                });
            });
        });
	});
}

// @source http://stackoverflow.com/a/5827895/330439
var walk = function(dir, subpath, done) {
    if (typeof subpath === "function" && typeof done === "undefined") {
        done = subpath;
        subpath = null;
    }
  var results = [];
  subpath = subpath || "";
  FS.readdir(dir + subpath, function(err, list) {
    if (err) return done(err);
    var pending = list.length;
    if (!pending) return done(null, results);
    list.forEach(function(filename) {
      var path = subpath + '/' + filename;
      FS.stat(dir + path, function(err, stat) {
        if (err) {
            results.push(path);
            return;
        }
        if (stat && stat.isDirectory()) {
          walk(dir, path, function(err, res) {
            if (err) return done(err);
            results = results.concat(res);
            if (!--pending) done(null, results);
          });
        } else {
          results.push(path);
          if (!--pending) done(null, results);
        }
      });
    });
  });
};


// NOTE: Should be run with `CWD` set to the root of a deployed PIO service.
if (require.main === module) {
    try {
        return exports.postdeploy(process.cwd()).then(function() {
            return process.exit(0);
        }).fail(function(err) {
            console.error(err.stack);
            return process.exit(1);
        });
    } catch(err) {
        console.error(err.stack);
        return process.exit(1);
    }
}

