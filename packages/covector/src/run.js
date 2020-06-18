const { spawn, timeout } = require("effection");
const { ChildProcess } = require("@effection/node");
const { once, on } = require("@effection/events");
const { configFile, changeFiles } = require("@covector/files");
const { assemble, mergeIntoConfig } = require("@covector/assemble");
const { fillChangelogs } = require("@covector/changelog");
const { apply } = require("@covector/apply");

module.exports.covector = function* covector({ command, cwd = process.cwd() }) {
  const config = yield configFile({ cwd });
  const changesArray = yield changeFiles({
    cwd,
    remove: command === "version",
  });
  const assembledChanges = assemble(changesArray);

  if (command === "status") {
    if (changesArray.length === 0) {
      console.info("There are no changes.");
      return "No changes.";
    } else {
      console.log("changes:");
      Object.keys(assembledChanges.releases).forEach((release) => {
        console.log(`${release} => ${assembledChanges.releases[release].type}`);
        console.dir(assembledChanges.releases[release].changes);
      });
      return `There are ${
        Object.keys(assembledChanges.releases).length
      } changes which include${Object.keys(assembledChanges.releases).map(
        (release) =>
          ` ${release} with ${assembledChanges.releases[release].type}`
      )}`;
    }
  } else if (command === "config") {
    delete config.vfile;
    return console.dir(config);
  } else if (command === "version") {
    yield raceTime();
    const commands = yield mergeIntoConfig({
      assembledChanges,
      config,
      command: "version",
    });

    const applied = yield apply({ changeList: commands, config, cwd });
    yield fillChangelogs({ applied, assembledChanges, config, cwd });
    return applied;
  } else if (command === "publish") {
    yield raceTime();
    const commands = yield mergeIntoConfig({
      assembledChanges,
      config,
      command: "publish",
    });

    let published = {};
    for (let pkg of commands) {
      if (!!pkg.getPublishedVersion) {
        const publishedVersionCommand = yield ChildProcess.spawn(
          pkg.getPublishedVersion,
          [],
          {
            cwd: pkg.path,
            shell: process.env.shell,
            stdio: "pipe",
            windowsHide: true,
          }
        );
        let version = "";
        let events = yield on(publishedVersionCommand.stdout, "data");

        while (version === "" || version === "undefined") {
          let data = yield events.next();
          version += !data.value
            ? data.toString().trim()
            : data.value.toString().trim();
        }
        yield once(publishedVersionCommand, "exit");
        if (pkg.pkgFile.version === version) {
          console.log(
            `${pkg.pkg}@${pkg.pkgFile.version} is already published. Skipping.`
          );
          continue;
        }
      }

      console.log(`publishing ${pkg.pkg} with ${pkg.publish}`);
      let child = yield ChildProcess.spawn(pkg.publish, [], {
        cwd: pkg.path,
        shell: process.env.shell,
        stdio: "inherit",
        windowsHide: true,
      });

      yield once(child, "exit");
      published[pkg] = true;
    }

    return published;
  }
};

function raceTime(
  t = 120000,
  msg = `timeout out waiting ${t / 1000}s for command`
) {
  return spawn(function* () {
    yield timeout(t);
    throw new Error(msg);
  });
}
