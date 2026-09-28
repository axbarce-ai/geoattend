// Wraps app.json so an EAS build profile can point the app at a different
// server. With API_BASE_URL unset (the preview/production profiles) the
// config is exactly app.json. The "local" profile in eas.json sets it to this
// PC's LAN address, which is plain http://, so that build also allows
// cleartext traffic -- Android release builds refuse http:// otherwise.
module.exports = ({ config }) => {
  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) return config;

  return {
    ...config,
    name: `${config.name} (Local)`,
    extra: { ...config.extra, apiBaseUrl },
    plugins: [
      ...(config.plugins || []),
      ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    ],
  };
};
