import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});
const IS_LAMBDA = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// Cache for SSM parameters and secrets to avoid repeated API calls
const parameterCache: Map<string, string> = new Map();

/**
 * Secret names in AWS Secrets Manager (for sensitive API keys)
 */
const SECRET_NAMES = {
  OPENAI_API_KEY: "/drazbe-ai/openai-api-key",
  GOOGLE_MAPS_API_KEY: "/drazbe-ai/google-maps-api-key",
} as const;

/**
 * Parameter names in SSM Parameter Store (for non-sensitive config)
 */
const SSM_PARAMETER_NAMES = {
  HOME_ADDRESS: "/drazbe-ai/home-address",
} as const;

type SecretKey = keyof typeof SECRET_NAMES;
type SSMKey = keyof typeof SSM_PARAMETER_NAMES;
type ConfigKey = SecretKey | SSMKey;

/**
 * Check if a key is a secret (stored in Secrets Manager)
 */
function isSecretKey(key: ConfigKey): key is SecretKey {
  return key in SECRET_NAMES;
}

/**
 * Get a configuration value from Secrets Manager/SSM Parameter Store (Lambda) or .env (local)
 * Values are cached after first retrieval
 */
async function getConfig(key: ConfigKey): Promise<string | undefined> {
  // Check cache first
  if (parameterCache.has(key)) {
    return parameterCache.get(key);
  }

  let value: string | undefined;

  if (IS_LAMBDA) {
    if (isSecretKey(key)) {
      // Fetch from Secrets Manager
      try {
        const result = await secretsClient.send(
          new GetSecretValueCommand({
            SecretId: SECRET_NAMES[key],
          })
        );
        value = result.SecretString;
      } catch (error) {
        console.warn(`Failed to get secret ${key}:`, error);
        value = undefined;
      }
    } else {
      // Fetch from SSM Parameter Store
      try {
        const result = await ssmClient.send(
          new GetParameterCommand({
            Name: SSM_PARAMETER_NAMES[key],
            WithDecryption: true,
          })
        );
        value = result.Parameter?.Value;
      } catch (error) {
        console.warn(`Failed to get SSM parameter ${key}:`, error);
        value = undefined;
      }
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
    const location = isSecretKey(key) ? SECRET_NAMES[key] : SSM_PARAMETER_NAMES[key];
    const type = isSecretKey(key) ? "secret" : "SSM parameter";
    throw new Error(
      `Required configuration ${key} not found. ` +
        (IS_LAMBDA ? `Set ${type} ${location}` : `Set ${key} in .env file`)
    );
  }
  return value;
}

/**
 * Pre-load all configuration values into cache
 * Call this at Lambda cold start to reduce latency for subsequent calls
 */
async function preloadConfig(): Promise<void> {
  const secretKeys = Object.keys(SECRET_NAMES) as SecretKey[];
  const ssmKeys = Object.keys(SSM_PARAMETER_NAMES) as SSMKey[];
  const allKeys = [...secretKeys, ...ssmKeys] as ConfigKey[];
  await Promise.all(allKeys.map((key) => getConfig(key)));
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
