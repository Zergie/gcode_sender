const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const imagePath = (...segments) => path.resolve(__dirname, 'images', ...segments);

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/*.node',
    },
    extraResource: [
      {
        from: path.resolve(__dirname, 'firmware-wasm'),
        to: 'firmware-wasm',
      },
    ],
    icon:
      process.platform === 'win32'
        ? imagePath('icon.ico')
        : process.platform === 'darwin'
          ? imagePath('icon.icns')
          : imagePath('icon.png'),
    ignore: [
      /^\/\.angular(?:\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/\.github(?:\/|$)/,
      /^\/coverage(?:\/|$)/,
      /^\/electron(?:\/|$)/,
      /^\/firmware-wasm(?:\/|$)/,
      /^\/images(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/public(?:\/|$)/,
      /^\/shared(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/test-results(?:\/|$)/,
      /^\/artifacts(?:\/|$)/,
      /^\/angular\.json$/,
      /^\/eslint\.config\.mjs$/,
      /^\/forge\.config\.js$/,
      /^\/tsconfig(?:\.[^/]+)?\.json$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'gcode_sender',
        setupIcon: imagePath('icon.ico'),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          icon: imagePath('icon.png'),
          categories: ['Utility'],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: imagePath('icon.png'),
          categories: ['Utility'],
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
