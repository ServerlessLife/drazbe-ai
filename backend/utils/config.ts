import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssmClient = new SSMClient({});
const IS_LAMBDA = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// Cache for parameters to avoid repeated API calls
const cache: Map<string, string> = new Map();

/**
 * Get a parameter from SSM Parameter Store (Lambda) or env variable (local)
 * @param name - Parameter name/path in SSM, or env variable name for local
 */
async function get(name: string): Promise<string | undefined> {
  if (cache.has(name)) {
    return cache.get(name);
  }

  let value: string | undefined;

  if (IS_LAMBDA) {
    try {
      const result = await ssmClient.send(
        new GetParameterCommand({ Name: name, WithDecryption: true })
      );
      value = result.Parameter?.Value;
    } catch (error) {
      console.warn(`Failed to get parameter ${name}:`, error);
    }
  } else {
    // Local: use env variable (extract key from path like "/drazbe-ai/openai-api-key" -> "OPENAI_API_KEY")
    const envKey = name.split("/").pop()?.toUpperCase().replace(/-/g, "_");
    value = envKey ? process.env[envKey] : undefined;
  }

  if (value) cache.set(name, value);
  return value;
}

/**
 * Clear the cache
 */
function clearCache(): void {
  cache.clear();
}

export const config = {
  get,
  clearCache,
};
