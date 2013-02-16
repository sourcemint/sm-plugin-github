
const ASSERT = require("assert");
const GITHUB = require("github");


var githubApis = {};

exports.for = function(API, plugin) {

    plugin.resolveLocator = function(originalLocator, options, callback) {
        var self = this;

        var locator = originalLocator.clone();

        if (!locator.vcs) locator.vcs = "git";

        var parsedPointer = API.URI_PARSER.parse2(locator.descriptor.pointer);

        ASSERT(parsedPointer.hostname === "github.com", "`parsedPointer.hostname` must be set to 'github.com', not '" + parsedPointer.hostname + "'");

        locator.pm = "github";
        locator.vendor = "github";

        var info = {};
        var m;
        if (parsedPointer.protocol === "git:") {
            var m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*?)(.git)?$/);
            if (!m) {
                return callback(new Error("Not a valid github.com public git URL!"));
            }
            parsedPointer.pathname = "/" + m[1] + "/" + m[2];
            if (parsedPointer.hash) {
                if (/^#\//.test(parsedPointer.hash)) {
                    return callback(new Error("Not a valid github.com URL '" + parsedPointer.href + "'! Hash/branch '" + parsedPointer.hash.substring(1) + "' may not begin with '/'!"));
                }
                parsedPointer.pathname += "/tree/" + parsedPointer.hash.substring(1);
            }
        }
        else if (/^git@/.test(parsedPointer.pathname)) {
            var m = parsedPointer.pathname.match(/^git@([^:]*):([^\/]*)\/([^\/]*).git$/);
            if (!m) {
                return callback(new Error("Not a valid github.com private git URL!"));
            }
            parsedPointer.pathname = "/" + m[2] + "/" + m[3];
            if (parsedPointer.hash) {
                parsedPointer.pathname += "/tree/" + parsedPointer.hash.substring(1);
            }
        }
        else if (/^\/(.*?)\.git$/.test(parsedPointer.pathname)) {
            var m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*)\.git$/);
            if (!m) {
                return callback(new Error("Not a valid github.com public git URL!"));
            }
            // NOTE: `locator.version` may not be an exact tag but that is ok because a locator
            //       does not deal with exact tags and only standard versions.
            parsedPointer.pathname = "/" + m[1] + "/" + m[2] + "/tree/" + (locator.rev || locator.version || "master");
        }
        // PINF-style uri. e.g. `github.com/sourcemint/sm-plugin-sm/~0.1.0`
        else if (m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*)\/(~?\d[\.\d-\w]*)$/)) {
            parsedPointer.pathname = "/" + m[1] + "/" + m[2] + "/tree/" + m[3];
        }

        var matchPath = parsedPointer.pathname;

/*
        // e.g. http://github.com/downloads/vakata/jstree/jstree_pre1.0_fix_1.zip
        m = matchPath.match(/^(\/downloads)(\/[^\/]*\/[^\/]*)(\/.*)$/);
        if (m) {
            matchPath = m[2] + m[1] + m[3];
        }
*/

        if((m = matchPath.match(/^\/([^\/]*)\/([^\/]*)\/?(?:(?:tarball|zipball|tree|commit|commits|tags)\/(.*?))?\/?(?:\/([^\/]*))?$/))) {

            var user = m[1];
            var repository = m[2];

            locator.vendor = "github";
            locator.id = user + "/" + repository;

            if (!m[3] && !m[4]) {
                if (locator.rev) {
                    locator.selector = locator.rev;
                } else
                if (locator.version) {
                    locator.selector = locator.version;
                } else {
                    locator.selector = "master";
                }
            }
            // NOTE: We don't know if we have a selector or rev yet.
            else if (!m[3] && m[4]) {
                locator.selector = m[4];
            }
            else if (m[3] && !m[4]) {
                locator.selector = m[3];
            }

            locator.getLocation = function(type) {
                var locations = {};
                locations["homepage"] = "https://github.com/" + user + "/" + repository;
                locations["pointer"] = "https://github.com/" + user + "/" + repository + "/commit/" + (this.rev || this.version || "");
                locations["uid"] = "github.com/" + user + "/" + repository + "/";
                locations["git-read"] = "git://github.com/" + user + "/" + repository + ".git";
                locations["git-write"] = "git@github.com:" + user + "/" + repository + ".git";
                if (this.rev) {
                    locations["zip"] = "https://github.com/" + user + "/" + repository + "/zipball/" + this.rev;
                    locations["gzip"] = "https://github.com/" + user + "/" + repository + "/tarball/" + this.rev;
                }
                return (type)?locations[type]:locations;
            }

            // Ask git plugin to resolve locator to determine if selector is a rev.
            return plugin.node.getPlugin("git", function(err, plugin) {
                if (err) return callback(err);

                return plugin.resolveLocator(locator, options, function(err, locator) {
                    if (err) return callback(err);

                    // The `git` plugin was not able to derive a `rev` or `version` as repository is not cloned localy.
                    if (locator.selector !== false && locator.rev === false && locator.version === false) {
                        return getGithubAPI(options, function(err, github) {
                            if (err) return callback(err);

                            var id = locator.id.split("/");
                            var args = {
                                user: id[0],
                                repo: id[1],
                                per_page: 100
                                // TODO: Paginate.
                            };
                            var strArgs = JSON.stringify(args);
                            return github.gitdata.getAllReferences(args, function(err, result) {
                                if (err) {
                                    if (result && result.headers["x-ratelimit-remaining"] === "0") {
                                        err = new Error("Github `x-ratelimit-limit` '" + result.headers["x-ratelimit-limit"] + "' exceeded!");
                                    } else {
                                        err.message += " (for `gitdata.getAllReferences()`)";
                                        if (
                                            // Not found.
                                            err.code === 404 || err.code === 403 ||
                                            // Empty.
                                            err.code === 409
                                        ) {
                                            return callback(null, locator);
                                        }
                                        console.error("`locator.id` is", locator.id);
                                        console.error("`result` is", result);
                                    }
                                    return callback(err);
                                }
                                if (!result || result.length === 0) return callback(null, locator);
                                result.forEach(function(entry) {
                                    if (locator.rev !== false) return;
                                    if (
                                        entry.ref === "refs/heads/" + locator.selector ||
                                        entry.ref === "refs/tags/" + locator.selector
                                    ) {
                                        locator.rev = entry.object.sha;
                                    }
                                    else if (entry.object.sha === locator.selector) {
                                        locator.rev = entry.object.sha;
                                        locator.selector = false;
                                    }
                                });
                                if (locator.selector === false) return callback(null, locator);
                                var args = {
                                    user: id[0],
                                    repo: id[1],
                                    sha: locator.selector
                                };
                                var strArgs = JSON.stringify(args);
                                return github.repos.getCommit(args, function(err, result) {
                                    if (err) {
                                        err.message += " (for `gitdata.getAllReferences()`)";
                                        if (err.code === 404) {
                                            return callback(null, locator);
                                        }
                                        console.error("`locator.id` is", locator.id);
                                        console.error("`result` is", result);
                                        return callback(err);
                                    }
                                    if (result && result.sha === locator.selector) {
                                        locator.rev = locator.selector;
                                        locator.selector = false;
                                    }
                                    return callback(null, locator);
                                });
                            });
                        });
                    }

                    return callback(null, locator);
                });
            });
            return callback(null, locator);
        } else {
            return callback(null, originalLocator);
        }
    }


    function getGithubAPI(options, callback) {
        var opts = API.UTIL.copy(options);
        opts.host = "api.github.com";
        opts.port = 443;
        var id = opts.host + ":" + opts.port;
        if (githubApis[id]) {
            if (API.UTIL.isArrayLike(githubApis[id])) {
                githubApis[id].push(callback);
            } else {
                callback(null, githubApis[id]);
            }
            return;
        }
        githubApis[id] = [
            callback
        ];
        function fail(err) {
            if (!githubApis[id]) return;
            var callbacks = githubApis[id];
            delete githubApis[id];
            callbacks.forEach(function(callback) {
                callback(err);
            });
        }
        return plugin.getExternalProxy(opts, function(err, proxy) {
            if (err) return fail(err);

            // TODO: Teach `github` lib to proxy.
            var github = new GITHUB({
                version: "3.0.0",
                proxy: proxy
            });
            // Silence log message.
            // TODO: Remove this once fixed: https://github.com/ajaxorg/node-github/issues/63
            github[github.version].sendError = function(err, block, msg, callback) {
                if (typeof err == "string") {
                    err = new Error(err);
                    err.code = 500;
                }
                if (callback)
                    callback(err);
            }

            function authenticate(callback) {
                var credentials = plugin.core.getCredentials(["github.com/sourcemint/sm-plugin-github/0", "api"]);
                function respond(credentials) {
                    if (credentials.token) {
                        return callback(null, {
                            type: "oauth",
                            token: credentials.token
                        });
                    } else {
                        return callback(null, {
                            type: "basic",
                            username: credentials.username,
                            password: credentials.password
                        });
                    }
                }
                if (credentials) {
                    return respond(credentials);
                }
                return API.SM_NODE_SERVER.requestOAuth("github", plugin.core.getProfile("name")).then(function(creds) {
                    ASSERT(typeof creds.token === "string");
                    credentials = creds;
                    plugin.core.setCredentials(["github.com/sourcemint/sm-plugin-github/0", "api"], credentials);
                    return respond(credentials);
                }).fail(function(err) {
                    console.error(err.stack);
                    console.error("RECOVER: Continuing without authenticating to github. Limit of 60 api calls per hour apply.");
                    return callback(null, false);
                });
            }

            return authenticate(function(err, credentials) {
                if (err) return fail(err);
                if (credentials) {
                    github.authenticate(credentials);
                    // TODO: If request fails due to auth failure remove `token` from stored credentials and re-authorize.
                }
                var callbacks = githubApis[id];
                githubApis[id] = github;
                callbacks.forEach(function(callback) {
                    callback(null, github);
                });
                return;
            });
        });
    }

    plugin.latest = function(options, callback) {
        var self = this;
        if (
            !plugin.node.summary.declaredLocator ||
            plugin.node.summary.declaredLocator.vendor !== "github"
        ) return callback(null, false);

        var info = false;

        return getGithubAPI(options, function(err, github) {
            if (err) return callback(err);

            var id = plugin.node.summary.declaredLocator.id.split("/");

            // TODO: Fetch all pages.
            return github.repos.getTags({
                user: id[0],
                repo: id[1],
                per_page: 100
            }, function(err, result) {
                if (err) {
                    if (result && result.headers["x-ratelimit-remaining"] === "0") {
                        err = new Error("Github `x-ratelimit-limit` '" + result.headers["x-ratelimit-limit"] + "' exceeded!");
                    } else {
                        if (err.code === 404 || err.code === 403) {
                            return callback(null, info);
                        }
                    }
                    return callback(err);
                }
                info = {
                    raw: {
                        tags: {}
                    },
                    versions: []
                };
                if (result && result.length > 0) {
                    result.forEach(function(item) {
                        if (item && item.commit) {
                            info.raw.tags[item.name] = item.commit.sha;
                            info.versions.push(item.name);
                            if (plugin.node.summary.declaredLocator.selector && item.name === plugin.node.summary.declaredLocator.selector) {
                                info.rev = item.commit.sha;
                            }
                        }
                    });
                }

                return github.repos.getBranches({
                    user: id[0],
                    repo: id[1]
                }, function(err, result) {
                    if (err) {
                        if (err.code === 404) {
                            return callback(null, info);
                        }
                        return callback(err);
                    }
                    if (result && result.length > 0) {
                        var branch = plugin.node.summary.declaredLocator.selector || "master";                    
                        result.forEach(function(item) {
                            if (typeof info.rev !== "undefined") return;
                            if (item.name === branch) {
                                info.rev = item.commit.sha;
                            }
                        });
                    }
                    if (typeof info.rev === "undefined") {
                        // No tags nor branches matching selector so we default to latest
                        // commit on branch master.
                        result.forEach(function(item) {
                            if (typeof info.rev !== "undefined") return;
                            if (item.name === "master") {
                                info.rev = item.commit.sha;
                            }
                        });
                    }
                    return callback(null, info);
                });
            });
        });
    }

    plugin.descriptorForSelector = function(locator, selector, options, callback) {
        return getGithubAPI(options, function(err, github) {
            if (err) return callback(err);

            var id = locator.id.split("/");

            var info = {};

            if (plugin.node.latest[locator.pm].versions.indexOf(selector) >= 0) {
                // `selector` is a tagged version.
                info.version = selector;
                info.rev = plugin.node.latest[locator.pm].raw.tags[selector];
            } else {
                // `selector` is assumed to be a ref (not a branch).
                info.rev = selector;
            }
            return github.repos.getContent({
                user: id[0],
                repo: id[1],
                path: "package.json",
                ref: info.rev
            }, function(err, result) {
                if (err) {
                    if (result && result.headers["x-ratelimit-remaining"] === "0") {
                        err = new Error("Github `x-ratelimit-limit` '" + result.headers["x-ratelimit-limit"] + "' exceeded!");
                    } else {
                        if (err.code === 404 || err.code === 403) {
                            return callback(null, info);
                        }
                    }
                    return callback(err);
                }
                if (result) {
                    if (result.encoding === "base64") {
                        try {
                            info.descriptor = new Buffer(result.content, "base64").toString("ascii");
                        } catch(err) {
                            err.message += " (parsing JSON descriptor for '" + locator + "')";
                            return callback(err);
                        }
                    } else {
                        return callback(new Error("Result encoding '" + result.encoding + "' not supported!"));
                    }
                }
                return callback(null, info);
            });
        });
    }

    plugin.hasRevInHistory = function(rev, options, callback) {
        if (!plugin.node.summary.declaredLocator) return callback(null, false);
        return getGithubAPI(options, function(err, github) {
            if (err) return callback(err);

            var id = plugin.node.summary.declaredLocator.id.split("/");

            return github.gitdata.getCommit({
                user: id[0],
                repo: id[1],
                sha: rev
            }, function(err, result) {
                if (err) {
                    if (result && result.headers["x-ratelimit-remaining"] === "0") {
                        err = new Error("Github `x-ratelimit-limit` '" + result.headers["x-ratelimit-limit"] + "' exceeded!");
                    } else {
                        if (err.code === 404 || err.code === 403) {
                            return callback(null, false);
                        }
                    }
                    return callback(err);
                }
                if (result) {
                    return callback(null, true);
                }
                return callback(null, false);
            });
        });
    }
}
