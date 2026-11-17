// Every user-visible name lives here so a rename is one edit.
export const PRODUCT = {
  id: "svgloop",
  title: "SVGLoop",
  version: "0.1.0",
  configFile: "svgloop.config.json",
  /** Prefix for environment variables: SVGLOOP_CONFIG, SVGLOOP_BASE_URL, ... */
  envPrefix: "SVGLOOP",
  /** Default output folder name (in the user's home folder) when no config file sets one. */
  outFolder: "SVGLoop",
} as const;

export const env = (name: string): string | undefined => process.env[`${PRODUCT.envPrefix}_${name}`] || undefined;
