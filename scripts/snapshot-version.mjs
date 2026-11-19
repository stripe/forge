const [baseVersion, runNumber] = process.argv.slice(2);
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-dev\.0)?$/.exec(
  baseVersion ?? '',
);

if (!version) {
  throw new TypeError(
    `Expected a stable package version or one ending in -dev.0, found ${baseVersion}`,
  );
}
if (!/^[1-9]\d*$/.test(runNumber ?? '')) {
  throw new TypeError('Expected a positive GitHub Actions run number.');
}

// A stable version starts development toward its next patch release.
const patch = BigInt(version[3]) + (version[4] ? 0n : 1n);
console.log(`${version[1]}.${version[2]}.${patch}-dev.${runNumber}`);
