// Tests log nothing unless LOG_LEVEL is set explicitly (e.g. LOG_LEVEL=debug npx jest)
process.env.LOG_LEVEL ??= 'silent';
