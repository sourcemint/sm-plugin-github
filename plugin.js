
const ASSERT = require("assert");
const GITHUB = require("github");


exports.for = function(API, plugin) {

    plugin.resolveLocator = function(locator, options) {
        var self = this;

        var parsedPointer = API.URI_PARSER.parse2(locator.descriptor.pointer);

        ASSERT(parsedPointer.hostname === "github.com", "`parsedPointer.hostname` must be set to `github.com`");

        locator.pm = "github";
        locator.vendor = "github";

        var info = {};
        var m;
        if (parsedPointer.protocol === "git:") {
            var m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*?)(.git)?$/);
            if (!m) {
                throw new Error("Not a valid github.com public git URL!");
            }
            parsedPointer.pathname = "/" + m[1] + "/" + m[2];
            if (parsedPointer.hash) {
                if (/^#\//.test(parsedPointer.hash)) {
                    throw new Error("Not a valid github.com URL '" + parsedPointer.href + "'! Hash/branch '" + parsedPointer.hash.substring(1) + "' may not begin with '/'!");
                }
                parsedPointer.pathname += "/tree/" + parsedPointer.hash.substring(1);
            }
        }
        else if (/^git@/.test(parsedPointer.pathname)) {
            var m = parsedPointer.pathname.match(/^git@([^:]*):([^\/]*)\/([^\/]*).git$/);
            if (!m) {
                throw new Error("Not a valid github.com private git URL!");
            }
            parsedPointer.pathname = "/" + m[2] + "/" + m[3];
            if (parsedPointer.hash) {
                parsedPointer.pathname += "/tree/" + parsedPointer.hash.substring(1);
            }
        }
        else if (/^\/(.*?)\.git$/.test(parsedPointer.pathname)) {
            var m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*)\.git$/);
            if (!m) {
                throw new Error("Not a valid github.com public git URL!");
            }
            parsedPointer.pathname = "/" + m[1] + "/" + m[2] + "/tree/master";
        }
        // PINF-style uri. e.g. `github.com/sourcemint/sm-plugin-sm/~0.1.0`
        else if (m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*)\/(~?\d[\.\d-\w]*)$/)) {
            parsedPointer.pathname = "/" + m[1] + "/" + m[2] + "/tree/" + m[3];
        }

        if((m = parsedPointer.pathname.match(/^\/([^\/]*)\/([^\/]*)\/?(?:(?:tarball|zipball|tree|commit|commits|tags)\/(.*?))?\/?(?:\/([^\/]*))?$/))) {

            var user = m[1];
            var repository = m[2];

            locator.vendor = "github";
            locator.id = user + "/" + repository;

            if (!m[3] && !m[4]) {
                locator.selector = "master";
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
                locations["pointer"] = "https://github.com/" + user + "/" + repository + "/commit/" + this.rev;
                locations["git-read"] = "git://github.com/" + user + "/" + repository + ".git";
                locations["git-write"] = "git@github.com:" + user + "/" + repository + ".git";
                if (this.rev) {
                    locations["zip"] = "https://github.com/" + user + "/" + repository + "/zipball/" + this.rev;
                    locations["tar"] = "https://github.com/" + user + "/" + repository + "/tarball/" + this.rev;
                }
                return (type)?locations[type]:locations;
            }
            // Ask git plugin to resolve locator to determine if selector is a rev.
            return plugin.node.getPlugin("git").then(function(plugin) {
                return plugin.resolveLocator(locator, options);
            });

        } else {
            throw new Error("Not a valid github.com URL!");
        }

        return self.API.Q.resolve();
    }

    plugin.latest = function(options) {
        var self = this;

        if (
            !plugin.node.summary.declaredLocator ||
            plugin.node.summary.declaredLocator.vendor !== "github"
        ) return API.Q.resolve(false);

        var opts = API.UTIL.copy(options);
        opts.host = "api.github.com";
        opts.port = 443;
        var info = false;
        return plugin.getExternalProxy(opts).then(function(proxy) {
            return API.Q.call(function() {
                var deferred = API.Q.defer();

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
                // TODO: Authenticate if credentials are available.

                var id = plugin.node.summary.declaredLocator.id.split("/");        

                github.repos.getBranches({
                    user: id[0],
                    repo: id[1]
                }, function(err, result) {
                    if (err) {
                        if (err.code === 404) {
                            return deferred.resolve();
                        }
                        return deferred.reject(err);
                    }
                    if (!result || result.length === 0) return deferred.resolve();
                    var branch = plugin.node.summary.declaredLocator.selector || "master";
                    result.forEach(function(item) {
                        if (info) return;
                        if (item.name === branch) {
                            info = {
                                rev: item.commit.sha
                            };
                        }
                    });
                    return deferred.resolve();
                });
                return deferred.promise;
            });
        }).then(function() {
            return info;
        });
    }
}
