import { Type, type TSchema } from "typebox";

/** Add UI task metadata without changing the tool's executable arguments or constraints. */
export function withTaskDescription(schema: TSchema): TSchema {
  const object = schema as TSchema & { properties: Record<string, TSchema>; required?: string[] };
  return {
    ...schema,
    properties: {
      ...object.properties,
      description: Type.String({
        description:
          "Required short task title in the user's language, such as 检查 Python 环境 or 拟合回归模型. Describe the purpose, not the code. Use one concise phrase without a running/completed prefix; never include secrets.",
        minLength: 1,
        maxLength: 80,
        pattern: "\\S",
      }),
    },
    required: [...new Set([...(object.required ?? []), "description"])],
  };
}
