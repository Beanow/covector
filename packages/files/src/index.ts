import { default as fsDefault, PathLike, statSync } from "fs";
// this is compatible with node@12+
const fs = fsDefault.promises;

import { all, Operation } from "effection";
import globby from "globby";
import path from "path";
import TOML from "@tauri-apps/toml";
import yaml from "js-yaml";
import semver from "semver";

import type {
  File,
  PkgMinimum,
  PackageFile,
  PreFile,
  ConfigFile,
  DepsKeyed,
} from "@covector/types";

export function* loadFile(
  file: PathLike,
  cwd: string
): Generator<any, File | void, any> {
  if (typeof file === "string") {
    const content = yield fs.readFile(path.join(cwd, file), {
      encoding: "utf-8",
    });
    const parsedPath = path.parse(file);
    return {
      content,
      path: path.posix
        .relative(cwd, path.posix.join(cwd, file))
        .split("\\")
        .join("/"),
      filename: parsedPath?.name ?? "",
      extname: parsedPath?.ext ?? "",
    };
  }
}

export function* saveFile(file: File, cwd: string): Generator<any, File, any> {
  if (typeof file.path !== "string")
    throw new Error(`Unable to handle saving of ${file}`);
  yield fs.writeFile(path.join(cwd, file.path), file.content, {
    encoding: "utf-8",
  });
  return file;
}

const parsePkg = (file: Partial<File>): PkgMinimum => {
  if (!file.content) throw new Error(`${file.path} does not have any content`);
  switch (file.extname) {
    case ".toml":
      const parsedTOML = TOML.parse(file.content);
      // @ts-ignore
      const { version } = parsedTOML.package;
      return {
        version: version,
        versionMajor: semver.major(version),
        versionMinor: semver.minor(version),
        versionPatch: semver.patch(version),
        versionPrerelease: semver.prerelease(version),
        deps: keyDeps(parsedTOML),
        // @ts-ignore
        pkg: parsedTOML,
      };
    case ".json":
      const parsedJSON = JSON.parse(file.content);
      return {
        version: parsedJSON.version,
        versionMajor: semver.major(parsedJSON.version),
        versionMinor: semver.minor(parsedJSON.version),
        versionPatch: semver.patch(parsedJSON.version),
        versionPrerelease: semver.prerelease(parsedJSON.version),
        deps: keyDeps(parsedJSON),
        pkg: parsedJSON,
      };
    case ".yml":
    case ".yaml":
      const parsedYAML = yaml.load(file.content);
      // type narrow:
      if (
        typeof parsedYAML === "string" ||
        typeof parsedYAML === "number" ||
        parsedYAML === null ||
        parsedYAML === undefined
      )
        throw new Error(`file improperly structured`);
      //@ts-ignore version is not on object?
      if (parsedYAML && (!parsedYAML.name || !parsedYAML.version))
        throw new Error(`missing version`);
      const verifiedYAML = parsedYAML as { name: string; version: string };
      return {
        version: verifiedYAML.version,
        versionMajor: semver.major(verifiedYAML.version),
        versionMinor: semver.minor(verifiedYAML.version),
        versionPatch: semver.patch(verifiedYAML.version),
        deps: keyDeps(parsedYAML),
        pkg: verifiedYAML,
      };
    default:
      // default case assuming a file with just a version number
      const stringVersion = file.content.trim();
      if (!semver.valid(stringVersion)) {
        throw new Error("not valid version");
      }
      return {
        version: stringVersion,
        versionMajor: semver.major(stringVersion),
        versionMinor: semver.minor(stringVersion),
        versionPatch: semver.patch(stringVersion),
        deps: {},
        pkg: { name: "", version: stringVersion },
      };
  }
};

const keyDeps = (parsed: any): DepsKeyed => {
  let deps: DepsKeyed = {};

  ["dependencies", "devDependencies", "dev-dependencies"].forEach(
    (depType: any) => {
      if (parsed[depType] && typeof parsed[depType] === "object") {
        Object.entries(parsed[depType]).forEach(
          ([dep, version]: [string, any]) => {
            if (!deps?.[dep]) deps[dep] = [];
            if (typeof version === "string") {
              deps[dep].push({
                type: depType,
                version,
              });
            } else if (typeof version === "object" && version.version) {
              deps[dep].push({
                type: depType,
                version: version.version,
              });
            }
          }
        );
      }
    }
  );
  return deps;
};

const stringifyPkg = ({
  newContents,
  extname,
}: {
  newContents: any;
  extname?: string;
}): string => {
  switch (extname) {
    case ".toml":
      return TOML.stringify(newContents);
    case ".json":
      return `${JSON.stringify(newContents, null, "  ")}\n`;
    case ".yml":
    case ".yaml":
      // this clobbers gaps between sections: https://github.com/nodeca/js-yaml/issues/441
      return yaml.dump(newContents);
    default:
      return newContents.version;
  }
};

export function* readAllPkgFiles({
  config,
  cwd,
}: {
  config: ConfigFile;
  cwd?: string;
}): Operation<Record<string, PackageFile>> {
  const pkgArray = Object.entries(config.packages);
  const readPkgs = pkgArray.map(([name, pkg]) =>
    readPkgFile({ cwd, pkgConfig: pkg, nickname: name })
  );
  const pkgFilesArray: PackageFile[] = yield all(readPkgs);

  return pkgFilesArray.reduce(
    (pkgs: Record<string, PackageFile>, pkg: PackageFile) => {
      if (pkg?.name) {
        pkgs[pkg.name] = pkg;
      }
      return pkgs;
    },
    {}
  );
}

export function* readPkgFile({
  cwd = process.cwd(),
  file,
  pkgConfig,
  nickname,
}: {
  cwd?: string;
  file?: string; // TODO, deprecate this
  pkgConfig?: { manager?: string; path?: string; packageFileName?: string };
  nickname: string;
}): Operation<PackageFile> {
  if (file) {
    const inputFile = yield loadFile(file, cwd);
    const parsed = parsePkg(inputFile);
    return {
      file: inputFile,
      ...parsed,
      name: nickname,
    };
  } else {
    if (pkgConfig?.path && pkgConfig?.packageFileName) {
      const configFile = path.join(pkgConfig.path, pkgConfig.packageFileName);
      const inputFile = yield loadFile(configFile, cwd);
      const parsed = parsePkg(inputFile);
      return {
        file: inputFile,
        ...parsed,
        name: nickname,
      };
    } else {
      // it will fail if path points to a dir, then we derive it
      let packageFile = "package.json"; // default
      if (pkgConfig && pkgConfig.manager) {
        if (/rust/.test(pkgConfig?.manager)) {
          packageFile = "Cargo.toml";
        } else if (
          /dart/.test(pkgConfig?.manager) ||
          /flutter/.test(pkgConfig?.manager)
        ) {
          packageFile = "pubspec.yaml";
        }
      }
      const deriveFile = path.join(pkgConfig?.path || "", packageFile);
      const inputFile = yield loadFile(deriveFile, cwd);
      const parsed = parsePkg(inputFile);
      return {
        file: inputFile,
        ...parsed,
        name: nickname,
      };
    }
  }
}

export function* writePkgFile({
  packageFile,
  cwd,
}: {
  packageFile: PackageFile;
  cwd: string;
}): Generator<any, File, any> {
  if (!packageFile.file)
    throw new Error(`no vfile present for ${packageFile.name}`);
  const fileNext = { ...packageFile.file };
  fileNext.content = stringifyPkg({
    newContents: packageFile.pkg,
    extname: packageFile.file.extname,
  });
  const inputFile = yield saveFile(fileNext, cwd);
  return inputFile;
}

export function* readPreFile({
  cwd,
  changeFolder = ".changes",
}: {
  cwd: string;
  changeFolder?: string;
}): Generator<any, PreFile | null, any> {
  try {
    const inputFile = yield loadFile(path.join(changeFolder, "pre.json"), cwd);
    const parsed = JSON.parse(inputFile.content);
    return {
      file: inputFile,
      ...parsed,
    };
  } catch (error) {
    return null;
  }
}

export const getPackageFileVersion = ({
  pkg,
  property = "version",
  dep,
}: {
  pkg: PackageFile;
  property?: string;
  dep?: string;
}): string => {
  if (pkg.file && pkg.pkg) {
    if (property === "version") {
      if (pkg.file.extname === ".json") {
        return pkg.pkg.version;
      } else if (pkg.file.extname === ".toml") {
        // @ts-ignore
        return pkg.pkg.package.version;
      } else {
        // covers yaml and generic
        return pkg.pkg.version;
      }
    } else if (property === "dependencies") {
      // same for every supported package file
      if (!dep || !pkg.pkg.dependencies) return "";
      if (typeof pkg.pkg.dependencies[dep] === "object") {
        //@ts-ignore
        if (!pkg.pkg.dependencies[dep].version) {
          throw new Error(
            `${pkg.name} has a dependency on ${dep}, and ${dep} does not have a version number. ` +
              `This cannot be published. ` +
              `Please pin it to a MAJOR.MINOR.PATCH reference.`
          );
        }
        //@ts-ignore
        return pkg.pkg.dependencies[dep].version;
      } else {
        return pkg.pkg.dependencies[dep];
      }
    } else if (property === "devDependencies") {
      // same for every supported package file
      if (!dep || !pkg.pkg.devDependencies) return "";
      if (typeof pkg.pkg.devDependencies[dep] === "object") {
        //@ts-ignore
        if (!pkg.pkg.devDependencies[dep].version) {
          throw new Error(
            `${pkg.name} has a devDependency on ${dep}, and ${dep} does not have a version number. ` +
              `This cannot be published. ` +
              `Please pin it to a MAJOR.MINOR.PATCH reference.`
          );
        }
        //@ts-ignore
        return pkg.pkg.devDependencies[dep].version;
      } else {
        return pkg.pkg.devDependencies[dep];
      }
    } else if (property === "dev-dependencies") {
      // same for every supported package file
      //@ts-ignore
      if (!dep || !pkg.pkg[property]) return "";
      //@ts-ignore
      if (typeof pkg.pkg[property][dep] === "object") {
        //@ts-ignore
        if (!pkg.pkg[property][dep].version) {
          throw new Error(
            `${pkg.name} has a devDependency on ${dep}, and ${dep} does not have a version number. ` +
              `This cannot be published. ` +
              `Please pin it to a MAJOR.MINOR.PATCH reference.`
          );
        }
        //@ts-ignore
        return pkg.pkg[property][dep].version;
      } else {
        //@ts-ignore
        return pkg.pkg[property][dep];
      }
    } else {
      return "";
    }
  }
  return "";
};

export const setPackageFileVersion = ({
  pkg,
  version,
  property = "version",
  dep,
}: {
  pkg: PackageFile;
  version: string;
  property?: string;
  dep?: string;
}): PackageFile => {
  if (pkg.file && pkg.pkg) {
    if (property === "version") {
      if (pkg.file.extname === ".json") {
        pkg.pkg.version = version;
      } else if (pkg.file.extname === ".toml") {
        // @ts-ignore
        pkg.pkg.package.version = version;
      } else {
        // covers yaml and generic
        pkg.pkg.version = version;
      }
    } else if (
      property === "dependencies" ||
      property === "devDependencies" ||
      property === "dev-dependencies"
    ) {
      if (property === "dependencies") {
        // same for every supported package file
        if (!dep || !pkg.pkg.dependencies) return pkg;
        if (typeof pkg.pkg.dependencies[dep] === "object") {
          // @ts-ignore TODO deal with nest toml
          pkg.pkg.dependencies[dep].version = version;
        } else {
          pkg.pkg.dependencies[dep] = version;
        }
      } else if (property === "devDependencies") {
        // same for every supported package file
        if (!dep || !pkg.pkg.devDependencies) return pkg;
        if (typeof pkg.pkg.devDependencies[dep] === "object") {
          // @ts-ignore TODO deal with nest toml
          pkg.pkg.devDependencies[dep].version = version;
        } else {
          pkg.pkg.devDependencies[dep] = version;
        }
      } else if (property === "dev-dependencies") {
        // same for every supported package file
        //@ts-ignore
        if (!dep || !pkg.pkg[property]) return pkg;
        //@ts-ignore
        if (typeof pkg.pkg[property][dep] === "object") {
          //@ts-ignore
          // @ts-ignore TODO deal with nest toml
          pkg.pkg[property][dep].version = version;
        } else {
          //@ts-ignore
          pkg.pkg[property][dep] = version;
        }
      }
    }
  }
  return pkg;
};

export function* writePreFile({
  preFile,
  cwd,
}: {
  preFile: PreFile;
  cwd: string;
}): Generator<any, File, any> {
  if (!preFile.file)
    throw new Error(`We could not find the pre.json to update.`);
  const { tag, changes } = preFile;
  const fileNext = { ...preFile.file };
  fileNext.content = stringifyPkg({
    newContents: { tag, changes },
    extname: preFile.file.extname,
  });
  const inputFile = yield saveFile(fileNext, cwd);
  return inputFile;
}

export const testSerializePkgFile = ({
  packageFile,
}: {
  packageFile: PackageFile;
}) => {
  try {
    if (!packageFile.file) throw `no package file present`;
    stringifyPkg({
      newContents: packageFile.pkg,
      extname: packageFile.file.extname,
    });
    return true;
  } catch (e: any) {
    if (e?.message === "Can only stringify objects, not null") {
      console.error(
        "It appears that a dependency within this repo does not have a version specified."
      );
    }
    throw new Error(`within ${packageFile.name} => ${e?.message}`);
  }
};

export function* configFile({
  cwd,
  changeFolder = ".changes",
}: {
  cwd: string;
  changeFolder?: string;
}): Generator<any, ConfigFile, any> {
  const inputFile = yield loadFile(path.join(changeFolder, "config.json"), cwd);
  const parsed = JSON.parse(inputFile.content);
  return {
    file: inputFile,
    ...parsed,
    ...checkFileOrDirectory({ cwd, config: parsed }),
  };
}

export const checkFileOrDirectory = ({
  cwd,
  config,
}: {
  cwd: string;
  config: ConfigFile;
}): ConfigFile["packages"] =>
  !config.packages
    ? {}
    : {
        packages: Object.keys(config.packages).reduce((packages, pkg) => {
          const packagePath = config.packages[pkg].path;
          if (!packagePath || !cwd) return packages;

          const checkDir = statSync(path.join(cwd, packagePath));
          if (checkDir.isFile()) {
            const dirName = path.dirname(packagePath);
            const packageFileName = path.basename(packagePath);
            packages[pkg] = {
              ...packages[pkg],
              path: dirName,
              packageFileName,
            };
            return packages;
          } else {
            return packages;
          }
        }, config?.packages),
      };

export const changeFiles = async ({
  cwd,
  changeFolder = ".changes",
}: {
  cwd: string;
  changeFolder?: string;
}): Promise<string[]> => {
  return await globby(
    [
      path.posix.join(changeFolder, "*.md"),
      `!${path.posix.join(changeFolder, "README.md")}`,
      `!${path.posix.join(changeFolder, "readme.md")}`,
      `!${path.posix.join(changeFolder, "Readme.md")}`,
    ],
    {
      cwd,
    }
  );
};

export function* loadChangeFiles({
  cwd,
  paths,
}: {
  cwd: string;
  paths: string[];
}): Generator<any, File[], any> {
  const files = paths.map((file) => loadFile(file, cwd));
  return yield all(files);
}

// redo this into a generator
export const changeFilesRemove = ({
  cwd,
  paths,
}: {
  cwd: string;
  paths: string[];
}) => {
  return Promise.all(
    paths.map(async (changeFilePath) => {
      await fs.unlink(path.posix.join(cwd, changeFilePath));
      return changeFilePath;
    })
  ).then((deletedPaths) => {
    deletedPaths.forEach((changeFilePath) =>
      console.info(`${changeFilePath} was deleted`)
    );
  });
};

export function* readChangelog({
  cwd,
  packagePath = "",
  create = true,
}: {
  cwd: string;
  packagePath?: string;
  create?: boolean;
}): Generator<any, File, any> {
  let file = null;
  try {
    file = yield loadFile(path.join(packagePath, "CHANGELOG.md"), cwd);
  } catch {
    if (create) {
      console.log("Could not load the CHANGELOG.md. Creating one.");
      file = {
        path: path.join(packagePath, "CHANGELOG.md"),
        content: "# Changelog\n\n\n",
      };
    }
  }
  return file;
}

export function* writeChangelog({
  changelog,
  cwd,
}: {
  changelog: File;
  cwd: string;
}): Generator<any, void | Error, any> {
  return yield saveFile(changelog, cwd);
}
