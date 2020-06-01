const vfile = require("to-vfile");
const globby = require("globby");
const fs = require("fs");
const path = require("path");
const TOML = require("@iarna/toml");

const parsePkg = (file) => {
  switch (file.extname) {
    case ".toml":
      const parsedTOML = TOML.parse(file.contents);
      return {
        name: parsedTOML.package.name,
        version: parsedTOML.package.version,
        pkg: parsedTOML,
      };
    case ".json":
      const parsedJSON = JSON.parse(file.contents);
      return {
        name: parsedJSON.name,
        version: parsedJSON.version,
        pkg: parsedJSON,
      };
  }
};

const stringifyPkg = ({ newContents, extname }) => {
  switch (extname) {
    case ".toml":
      return TOML.stringify(file.contents);
    case ".json":
      return `${JSON.stringify(newContents, null, "  ")}\n`;
  }
  throw new Error("Unknown package file type.");
};

module.exports.readPkgFile = async (file) => {
  const inputVfile = await vfile.read(file, "utf8");
  const parsed = parsePkg(inputVfile);
  return {
    vfile: inputVfile,
    ...parsed,
  };
};

module.exports.writePkgFile = async ({ packageFile }) => {
  const vFileNext = { ...packageFile.vfile };
  vFileNext.contents = stringifyPkg({
    newContents: packageFile.pkg,
    extname: packageFile.vfile.extname,
  });
  const inputVfile = await vfile.write(vFileNext, "utf8");
  return inputVfile;
};

module.exports.configFile = async ({ cwd, changeFolder = ".changes" }) => {
  const inputVfile = await vfile.read(
    path.join(cwd, changeFolder, "config.json"),
    "utf8"
  );
  const parsed = JSON.parse(inputVfile.contents);
  return {
    vfile: inputVfile,
    ...parsed,
  };
};

module.exports.changeFiles = async ({ cwd, changeFolder = ".changes" }) => {
  const paths = await globby([path.posix.join(changeFolder, "*.md")], {
    cwd,
    ignore: ["**/readme.md"],
  });

  const vfiles = paths
    .map((file) => vfile.readSync(path.join(cwd, file), "utf8"))
    .map((v) => v.contents);

  for (let path of paths) {
    await fs.unlink(path, (err) => {
      if (err) throw err;
      console.log("path/file.txt was deleted");
    });
  }

  return vfiles;
};
