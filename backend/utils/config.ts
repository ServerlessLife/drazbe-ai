import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssmClient = new SSMClient({});
const IS_LAMBDA = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// Cache for SSM parameters to avoid repeated API calls
const parameterCache: Map<string, string> = new Map();

/**
 * Parameter names in SSM Parameter Store
 */
const SSM_PARAMETER_NAMES = {
  OPENAI_API_KEY: "/drazbe-ai/openai-api-key",
  GOOGLE_MAPS_API_KEY: "/drazbe-ai/google-maps-api-key",
  HOME_ADDRESS: "/drazbe-ai/home-address",
} as const;

type ConfigKey = keyof typeof SSM_PARAMETER_NAMES;

/**
 * Get a configuration value from SSM Parameter Store (Lambda) or .env (local)
 * Values are cached after first retrieval
 */
async function getConfig(key: ConfigKey): Promise<string | undefined> {
  // Check cache first
  if (parameterCache.has(key)) {
    return parameterCache.get(key);
  }

  let value: string | undefined;

  if (IS_LAMBDA) {
    // Running in Lambda - fetch from SSM Parameter Store
    try {
      const result = await ssmClient.send(
        new GetParameterCommand({
          Name: SSM_PARAMETER_NAMES[key],
          WithDecryption: true,
        })
      );
      value = result.Parameter?.Value;
    } catch (error) {
      // Parameter not found or access denied
      console.warn(`Failed to get SSM parameter ${key}:`, error);
      value = undefined;
    }
  } else {
    // Running locally - use environment variable from .env
    value = process.env[key];
  }

  // Cache the value (even if undefined to avoid repeated failed lookups)
  if (value !== undefined) {
    parameterCache.set(key, value);
  }

  return value;
}

/**
 * Get a required configuration value - throws if not found
 */
async function getRequiredConfig(key: ConfigKey): Promise<string> {
  const value = await getConfig(key);
  if (!value) {
    throw new Error(
      `Required configuration ${key} not found. ` +
        (IS_LAMBDA ? `Set SSM parameter ${SSM_PARAMETER_NAMES[key]}` : `Set ${key} in .env file`)
    );
  }
  return value;
}

/**
 * Pre-load all configuration values into cache
 * Call this at Lambda cold start to reduce latency for subsequent calls
 */
async function preloadConfig(): Promise<void> {
  const keys = Object.keys(SSM_PARAMETER_NAMES) as ConfigKey[];
  await Promise.all(keys.map((key) => getConfig(key)));
}

/**
 * Clear the configuration cache
 */
function clearCache(): void {
  parameterCache.clear();
}

export const config = {
  get: getConfig,
  getRequired: getRequiredConfig,
  preload: preloadConfig,
  clearCache,
  SSM_PARAMETER_NAMES,
};
