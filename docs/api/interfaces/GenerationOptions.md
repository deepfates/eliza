[@ai16z/eliza v0.1.5-alpha.3](../index.md) / GenerationOptions

# Interface: GenerationOptions

Configuration options for generating objects with a model.

## Properties

### runtime

> **runtime**: [`IAgentRuntime`](IAgentRuntime.md)

#### Defined in

[packages/core/src/generation.ts:1114](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1114)

***

### context

> **context**: `string`

#### Defined in

[packages/core/src/generation.ts:1115](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1115)

***

### modelClass

> **modelClass**: [`ModelClass`](../enumerations/ModelClass.md)

#### Defined in

[packages/core/src/generation.ts:1116](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1116)

***

### schema?

> `optional` **schema**: `ZodType`\<`any`, `ZodTypeDef`, `any`\>

#### Defined in

[packages/core/src/generation.ts:1117](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1117)

***

### schemaName?

> `optional` **schemaName**: `string`

#### Defined in

[packages/core/src/generation.ts:1118](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1118)

***

### schemaDescription?

> `optional` **schemaDescription**: `string`

#### Defined in

[packages/core/src/generation.ts:1119](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1119)

***

### stop?

> `optional` **stop**: `string`[]

#### Defined in

[packages/core/src/generation.ts:1120](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1120)

***

### mode?

> `optional` **mode**: `"auto"` \| `"json"` \| `"tool"`

#### Defined in

[packages/core/src/generation.ts:1121](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1121)

***

### experimental\_providerMetadata?

> `optional` **experimental\_providerMetadata**: `Record`\<`string`, `unknown`\>

#### Defined in

[packages/core/src/generation.ts:1122](https://github.com/deepfates/eliza/blob/main/packages/core/src/generation.ts#L1122)
