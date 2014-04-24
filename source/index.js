#!/usr/bin/env node

const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const Q = require("q");
const DIRSUM = require("dirsum");
const CRYPTO = require("crypto");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;
const COLORS = require("colors");
const S3 = require("s3");
const DOT = require("dot");

COLORS.setTheme({
    error: "red"
});


exports.postdeploy = function(serviceBasePath) {

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
		return Q.denodeify(function(callback) {
            return DIRSUM.digest(PATH.join(syncPath, "source"), "sha1", function (err, sourceHashes) {
                if (err) return callback(err);

    			return DIRSUM.digest(PATH.join(syncPath, "scripts"), "sha1", function (err, scriptsHashes) {
    				if (err) return callback(err);

    				return callback(null, {
                        sourceHash: sourceHashes.hash,
                        scriptsHash: scriptsHashes.hash
                    });
    			});
            });
		})();
	}

    function scanConfig() {
        return Q.denodeify(FS.readJson)(configPath).then(function(config) {
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
                return EXEC('cp -Rf "' + syncPath + '" "' + tmpPath + '"', function(err, stdout, stderr) {
                    if (err) {
                        console.error(stdout);
                        console.error(stderr);
                        return callback(err);
                    }
                    FS.unlinkSync(PATH.join(tmpPath, ".pio.json"));

                    // TODO: Put this into a plugin.
                    function replaceScriptVariables(callback) {
                        console.log("Using http://olado.github.io/doT/ to replace variables in: " + PATH.join(tmpPath, "scripts"));
                        console.log("variables", configInfo.json);
                        return Q.denodeify(walk)(PATH.join(tmpPath, "scripts")).then(function(filelist) {
                            function replaceInFile(path) {
                                return Q.denodeify(function(callback) {
                                    return FS.readFile(PATH.join(tmpPath, "scripts", path), "utf8", function(err, templateSource) {
                                        if (err) return callback(err);
                                        console.log("Replacing varibales in: " + PATH.join(tmpPath, "scripts", path));
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
    }

	function build(preparedPath, builtPath, syncInfo, configInfo) {
        var tmpPath = builtPath + "~" + Date.now();
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
                        console.log(("Skipping install. Found existing built cache at: " + builtPath).yellow);
                        return callback(null, false);
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

                var cacheUri =
                    configInfo.json.config.pio.serviceRepositoryUri + "/" +
                    configInfo.json.config["pio.service"].id + "-" +
                    syncInfo.sourceHash.substring(0, 7) + "-build-" + process.platform + "-" + process.arch + ".tgz";

                if (!/^https:\/\/s3\.amazonaws\.com\//.test(cacheUri)) {
                    throw new Error("'config.pio.serviceRepositoryUri' must begin with 'https://s3.amazonaws.com/'");
                } else {
                    cacheUri = cacheUri.replace(/^https:\/\/s3\.amazonaws\.com\//, "");
                }

                var archivePath = tmpPath + ".tgz";

                function checkInstallCache(callback) {

                    function getClient() {
                        return S3.createClient({
                            key: pioConfig.env.AWS_ACCESS_KEY,
                            secret: pioConfig.env.AWS_SECRET_KEY,
                            bucket: cacheUri.split("/").shift()
                        });
                    }

                    function upload(callback) {
                        var uploader = getClient().upload(archivePath, cacheUri.split("/").slice(1).join("/"), {
                            'Content-Type': 'application/x-tar',
                            'x-amz-acl': 'private'
                        });
                        uploader.on('error', callback);
                        uploader.on('progress', function(amountDone, amountTotal) {
                            console.log("upload progress", amountDone, amountTotal);
                        });
                        uploader.on('end', function(url) {
                            console.log("Uploaded: " + url);
                            return callback(null);
                        });
                    }

                    function returnNotFound(callback) {
                        return callback(null, {
                            provisioned: false,
                            upload: function(callback) {

// TODO: Run separately as plugin on `publish`.
return callback(null);

                                console.log(("Creating archive '" + archivePath + "' from install '" + tmpPath + "'").magenta);
                                
                                return EXEC('tar --dereference -zcf "' + PATH.basename(archivePath) + '" -C "' + PATH.dirname(tmpPath) + '/" "' + PATH.basename(tmpPath) + '"', {
                                    cwd: PATH.dirname(archivePath)
                                }, function(err, stdout, stderr) {
                                    if (err) {
                                        process.stderr.write(stdout);
                                        process.stderr.write(stderr);
                                        return callback(err);
                                    }
                                    console.log("Archive created. Uploading to S3.".magenta);
                                    return upload(callback);
                                });
                            }
                        });
                    }

                    if (process.env.PIO_FORCE) {
                        console.log(("Skip checking AWS S3 for install cache '" + cacheUri + "' due to PIO_FORCE!").yellow);
                        return returnNotFound(callback);
                    }

                    console.log(("Checking AWS S3 for install cache: " + cacheUri).cyan);

                    function download(callback) {
                        console.log("Check if archive exists online: " + cacheUri.split("/").slice(1).join("/"));
                        if (!FS.existsSync(PATH.dirname(archivePath))) {
                            FS.mkdirsSync(PATH.dirname(archivePath));
                        }
                        var downloader = getClient().download(cacheUri.split("/").slice(1).join("/"), archivePath);
                        downloader.on('error', function(err) {
                            if (/404/.test(err.message)) {
                                console.log("Archive not found in online cache.");
                                return callback(null, null);
                            }
                            return callback(err);
                        });
                        downloader.on('progress', function(amountDone, amountTotal) {
                            console.log("download progress", amountDone, amountTotal);
                        });
                        return downloader.on('end', function() {
                            return callback(null, archivePath);
                        });
                    }

                    return download(function(err, downloadedArchivePath) {
                        if (err) return callback(err);
                        if (downloadedArchivePath) {
                            console.log("Extract '" + archivePath + "' to '" + tmpPath + "'");
                            FS.mkdirsSync(tmpPath);
                            return EXEC('tar -xzf "' + PATH.basename(archivePath) + '" --strip 1 -C "' + tmpPath + '/"', {
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
                                console.log("Archive extracted to: " + tmpPath);
                                return FS.rename(tmpPath, builtPath, function(err) {
                                    if (err) return callback(err);
                                    return callback(null, {
                                        provisioned: true
                                    });
                                });
                            });
                        }
                        return returnNotFound(callback);
                    });
                }

                return checkInstallCache(function(err, cacheInfo) {
                    if (err) return callback(err);
                    if (cacheInfo.provisioned) {
                        console.log("Using built cache: " + builtPath);
                        return callback(null, builtPath);
                    }
                    console.log("Installing ...".magenta);
                    FS.mkdirsSync(tmpPath);
                    FS.outputFileSync(PATH.join(tmpPath, "bin/activate.sh"), [
                        '#!/bin/sh -e',
                        '. /opt/bin/activate.sh'
                    ].join("\n"));
                    return EXEC('cp -Rf "' + PATH.join(preparedPath, "source") + '" "' + PATH.join(tmpPath, "build") + '"', function(err, stdout, stderr) {
                        if (err) {
                            console.error(stdout);
                            console.error(stderr);
                            return callback(err);
                        }
                        FS.chmodSync(PATH.join(tmpPath, "build"), 0744);
                        console.log("Linking '" + PATH.join(preparedPath, "source") + "' to '" + PATH.join(tmpPath, "source") + "'");
                        FS.symlinkSync(PATH.relative(PATH.join(tmpPath), PATH.join(preparedPath, "source")), PATH.join(tmpPath, "source"));
                        if (!FS.existsSync(PATH.join(tmpPath, "bin"))) {
                            FS.mkdirsSync(PATH.join(tmpPath, "bin"));
                        }
                        var execEnv = {};
                        for (var name in configInfo.json.env) {
                            execEnv[name] = configInfo.json.env[name];
                        }
                        execEnv.PATH = PATH.join(__dirname, "node_modules/.bin") + ":" + process.env.PATH;
                        execEnv.PIO_CONFIG_PATH = PATH.join(syncPath, ".pio.json");
                        execEnv.PIO_SERVICE_PATH = tmpPath;
                        execEnv.PIO_SCRIPTS_PATH = PATH.join(preparedPath, "scripts");
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
                            return cacheInfo.upload(function(err) {
                                if (err) return callback(err);
                                return FS.rename(tmpPath, builtPath, function(err) {
                                    if (err) return callback(err);
                                    return callback(null, builtPath);
                                });
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
            console.log("Build Failed! Moving failed build to: " + failedPath);
            throw err;
        });
	}

    function configure(preparedPath, builtPath, deploymentPath, configInfo) {
        var tmpPath = deploymentPath; // + "~" + Date.now();
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
                return EXEC('cp -Rf "' + builtPath + '" "' + tmpPath + '"', function(err, stdout, stderr) {
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

                    FS.outputFileSync(PATH.join(tmpPath, ".pio.json"), JSON.stringify(configInfo.json, null, 4));

                    return FS.copy(configPath, PATH.join(tmpPath, PATH.basename(configPath)), function(err) {
                        if (err) return callback(err);

                        return EXEC('cp -Rf "' + PATH.join(preparedPath, "scripts") + '" "' + PATH.join(tmpPath, "scripts") + '"', function(err, stdout, stderr) {
                            if (err) {
                                console.error(stdout);
                                console.error(stderr);
                                return callback(err);
                            }

                            return EXEC('cp -Rf "' + PATH.join(tmpPath, "build") + '" "' + PATH.join(tmpPath, "install") + '"', function(err, stdout, stderr) {
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
                    });
                });
            });
        })().fail(function(err) {
            var failedPath = tmpPath + ".failed";
            // TODO: Write our log with failure info tp `failedPath + '/.pio/error'
            FS.renameSync(tmpPath, failedPath);
            console.log("Configure Failed! Moving failed deployment to: " + failedPath);
            throw err;
        });
    }

    function run(deploymentPath, configInfo) {
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
            FS.outputFileSync(PATH.join(serviceBasePath, "package.json"), JSON.stringify({
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
                    }
                }
            }, null, 4));
        });
    }

    return ensurePrerequisites().then(function() {

    	return scanSync().then(function(syncInfo) {

            var preparedPath = PATH.join(preparedBasePath, syncInfo.scriptsHash + "-" + syncInfo.sourceHash);
            var builtPath = PATH.join(builtBasePath, syncInfo.scriptsHash + "-" + syncInfo.sourceHash);

            return scanConfig().then(function(configInfo) {

                return prepare(preparedPath, configInfo).then(function() {

                    console.log("Using prepared path: " + preparedPath);

                    return build(preparedPath, builtPath, syncInfo, configInfo).then(function() {

                        console.log("Using built path: " + builtPath);
/*
                        var shasum = CRYPTO.createHash("sha1");
                        shasum.update(syncInfo.sourceHash + ":" + syncInfo.scriptsHash + ":" + configInfo.hash);
                        var deploymentPath = PATH.join(deploymentBasePath, shasum.digest("hex"));
*/
                        var deploymentPath = PATH.join(deploymentBasePath, syncInfo.scriptsHash + "-" + syncInfo.sourceHash + "-" + configInfo.hash);
                        console.log("Using deployment path: " + deploymentPath);

                        return configure(preparedPath, builtPath, deploymentPath, configInfo).then(function() {

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
        if (stat && stat.isDirectory()) {
          walk(dir, path, function(err, res) {
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

