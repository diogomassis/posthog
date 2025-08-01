import Chance from 'chance'
import merge from 'deepmerge'
import { DateTime, Settings } from 'luxon'

import { NativeDestinationExecutorService } from '~/cdp/services/native-destination-executor.service'
import { defaultConfig } from '~/config/config'
import { CyclotronInputType } from '~/schema/cyclotron'
import { GeoIp, GeoIPService } from '~/utils/geoip'

import { Hub } from '../../../types'
import { cleanNullValues } from '../../hog-transformations/transformation-functions'
import { HogExecutorService } from '../../services/hog-executor.service'
import { HogInputsService } from '../../services/hog-inputs.service'
import {
    CyclotronJobInvocationHogFunction,
    CyclotronJobInvocationResult,
    HogFunctionInputSchemaType,
    HogFunctionInvocationGlobals,
    HogFunctionInvocationGlobalsWithInputs,
    HogFunctionTemplate,
    HogFunctionTemplateCompiled,
    HogFunctionType,
    NativeTemplate,
} from '../../types'
import { cloneInvocation } from '../../utils/invocation-utils'
import { createInvocation } from '../../utils/invocation-utils'
import { compileHog } from '../compiler'

export type DeepPartialHogFunctionInvocationGlobals = {
    event?: Partial<HogFunctionInvocationGlobals['event']>
    person?: Partial<HogFunctionInvocationGlobals['person']>
    source?: Partial<HogFunctionInvocationGlobals['source']>
    request?: HogFunctionInvocationGlobals['request']
}

const compileObject = async (obj: any): Promise<any> => {
    if (Array.isArray(obj)) {
        return Promise.all(obj.map((item) => compileObject(item)))
    } else if (typeof obj === 'object') {
        const res: Record<string, any> = {}
        for (const [key, value] of Object.entries(obj)) {
            res[key] = await compileObject(value)
        }
        return res
    } else if (typeof obj === 'string') {
        return await compileHog(`return f'${obj}'`)
    } else {
        return undefined
    }
}

export const compileInputs = async (
    template: HogFunctionTemplate | NativeTemplate,
    _inputs: Record<string, any>
): Promise<Record<string, CyclotronInputType>> => {
    const defaultInputs = template.inputs_schema.reduce((acc, input) => {
        if (typeof input.default !== 'undefined') {
            acc[input.key] = input.default
        }
        return acc
    }, {} as Record<string, CyclotronInputType>)

    const allInputs = { ...defaultInputs, ..._inputs }

    // Don't compile inputs that don't suppport templating
    const compiledEntries = await Promise.all(
        Object.entries(allInputs).map(async ([key, value]) => {
            const schema = template.inputs_schema.find((input) => input.key === key)
            if (schema?.templating === false) {
                return [key, value]
            }
            return [key, await compileObject(value)]
        })
    )

    return compiledEntries.reduce((acc, [key, value]) => {
        acc[key] = {
            value: allInputs[key],
            bytecode: value,
        }
        return acc
    }, {} as Record<string, CyclotronInputType>)
}

const createGlobals = (
    globals: DeepPartialHogFunctionInvocationGlobals = {}
): HogFunctionInvocationGlobalsWithInputs => {
    return {
        ...globals,
        inputs: {},
        project: { id: 1, name: 'project-name', url: 'https://us.posthog.com/projects/1' },
        event: {
            uuid: 'event-id',
            event: 'event-name',
            distinct_id: 'distinct-id',
            properties: { $current_url: 'https://example.com', ...globals.event?.properties },
            timestamp: '2024-01-01T00:00:00Z',
            elements_chain: '',
            url: 'https://us.posthog.com/projects/1/events/1234',
            ...globals.event,
        },
        person: {
            id: 'person-id',
            name: 'person-name',
            properties: { email: 'example@posthog.com', ...globals.person?.properties },
            url: 'https://us.posthog.com/projects/1/persons/1234',
            ...globals.person,
        },
        source: {
            url: 'https://us.posthog.com/hog_functions/1234',
            name: 'hog-function-name',
            ...globals.source,
        },
    }
}

export class TemplateTester {
    public template: HogFunctionTemplateCompiled
    private executor: HogExecutorService
    private mockHub: Hub

    private geoipService?: GeoIPService
    public geoIp?: GeoIp

    public mockFetch = jest.fn()
    public mockPrint = jest.fn()
    constructor(private _template: HogFunctionTemplate) {
        this.template = {
            ..._template,
            bytecode: [],
        }

        this.mockHub = {} as any

        this.executor = new HogExecutorService(this.mockHub)
    }

    /*
    we need transformResult to be able to test the geoip template
    the same way we did it here https://github.com/PostHog/posthog-plugin-geoip/blob/a5e9370422752eb7ea486f16c5cc8acf916b67b0/index.test.ts#L79
    */
    async beforeEach() {
        if (!this.geoipService) {
            this.geoipService = new GeoIPService(defaultConfig)
        }

        if (!this.geoIp) {
            this.geoIp = await this.geoipService.get()
        }

        this.template = {
            ...this._template,
            bytecode: await compileHog(this._template.code),
        }

        this.executor = new HogExecutorService(this.mockHub)
    }

    createGlobals(globals: DeepPartialHogFunctionInvocationGlobals = {}): HogFunctionInvocationGlobalsWithInputs {
        return createGlobals(globals)
    }

    async invoke(
        _inputs: Record<string, any>,
        _globals?: DeepPartialHogFunctionInvocationGlobals
    ): Promise<CyclotronJobInvocationResult<CyclotronJobInvocationHogFunction>> {
        if (this.template.mapping_templates) {
            throw new Error('Mapping templates found. Use invokeMapping instead.')
        }

        const compiledInputs = await compileInputs(this.template, _inputs)
        const globals = this.createGlobals(_globals)

        const { code, ...partialTemplate } = this.template
        const hogFunction: HogFunctionType = {
            ...partialTemplate,
            hog: code,
            inputs: compiledInputs,
            bytecode: this.template.bytecode,
            team_id: 1,
            enabled: true,
            mappings: this.template.mappings || null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            is_addon_required: false,
            deleted: false,
        }

        const globalsWithInputs = await this.executor.buildInputsWithGlobals(hogFunction, globals)
        const invocation = createInvocation(globalsWithInputs, hogFunction)

        const transformationFunctions = {
            geoipLookup: (val: unknown): any => {
                return typeof val === 'string' ? this.geoIp?.city(val) : null
            },
            cleanNullValues,
        }

        const extraFunctions = invocation.hogFunction.type === 'transformation' ? transformationFunctions : {}

        return this.executor.execute(invocation, { functions: extraFunctions })
    }

    async invokeMapping(
        mapping_name: string,
        _inputs: Record<string, any>,
        _globals?: DeepPartialHogFunctionInvocationGlobals,
        mapping_inputs?: Record<string, any>
    ): Promise<CyclotronJobInvocationResult<CyclotronJobInvocationHogFunction>> {
        if (!this.template.mapping_templates) {
            throw new Error('No mapping templates found')
        }

        const compiledInputs = await compileInputs(this.template, _inputs)

        const compiledMappingInputs = {
            ...this.template.mapping_templates.find((mapping) => mapping.name === mapping_name),
            inputs: mapping_inputs ?? {},
        }

        if (!compiledMappingInputs.inputs_schema) {
            throw new Error('No inputs schema found for mapping')
        }

        const processedInputs = await Promise.all(
            compiledMappingInputs.inputs_schema
                .filter((input) => typeof input.default !== 'undefined')
                .map(async (input) => {
                    const value = mapping_inputs?.[input.key] ?? input.default
                    return {
                        key: input.key,
                        value,
                        bytecode: await compileObject(value),
                    }
                })
        )

        const inputsObj = processedInputs.reduce((acc, item) => {
            acc[item.key] = {
                value: item.value,
                bytecode: item.bytecode,
            }
            return acc
        }, {} as Record<string, CyclotronInputType>)

        compiledMappingInputs.inputs = inputsObj

        const { code, ...partialTemplate } = this.template
        const hogFunction: HogFunctionType = {
            ...partialTemplate,
            hog: code,
            team_id: 1,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            deleted: false,
            inputs: compiledInputs,
            mappings: [compiledMappingInputs],
            is_addon_required: false,
        }

        const globalsWithInputs = await this.executor.buildInputsWithGlobals(
            hogFunction,
            this.createGlobals(_globals),
            compiledMappingInputs.inputs
        )

        const invocation = createInvocation(globalsWithInputs, hogFunction)

        return this.executor.execute(invocation)
    }

    async invokeFetchResponse(
        invocation: CyclotronJobInvocationHogFunction,
        response: { status: number; body: Record<string, any> }
    ): Promise<CyclotronJobInvocationResult<CyclotronJobInvocationHogFunction>> {
        const modifiedInvocation = cloneInvocation(invocation)

        modifiedInvocation.state.vmState!.stack.push({
            status: response.status,
            body: response.body,
        })

        return this.executor.execute(modifiedInvocation)
    }
}

export class DestinationTester {
    private executor: NativeDestinationExecutorService
    private inputsService: HogInputsService
    private mockFetch = jest.fn()

    constructor(private template: NativeTemplate) {
        this.template = template
        this.executor = new NativeDestinationExecutorService({} as any)
        this.inputsService = new HogInputsService({} as any)

        this.executor.fetch = this.mockFetch

        this.mockFetch.mockResolvedValue({
            status: 200,
            json: () => Promise.resolve({ status: 'OK' }),
            text: () => Promise.resolve(JSON.stringify({ status: 'OK' })),
            headers: { 'content-type': 'application/json' },
        })
    }

    createGlobals(globals: DeepPartialHogFunctionInvocationGlobals = {}): HogFunctionInvocationGlobalsWithInputs {
        return createGlobals(globals)
    }

    mockFetchResponse(response?: { status?: number; body?: Record<string, any>; headers?: Record<string, string> }) {
        const defaultResponse = {
            status: 200,
            body: { status: 'OK' },
            headers: { 'content-type': 'application/json' },
        }

        const finalResponse = { ...defaultResponse, ...response }

        this.mockFetch.mockResolvedValue({
            status: finalResponse.status,
            json: () => Promise.resolve(finalResponse.body),
            text: () => Promise.resolve(JSON.stringify(finalResponse.body)),
            headers: finalResponse.headers,
        })
    }

    beforeEach() {
        Settings.defaultZone = 'UTC'
        const fixedTime = DateTime.fromISO('2025-01-01T00:00:00Z').toJSDate()
        jest.spyOn(Date, 'now').mockReturnValue(fixedTime.getTime())
    }

    afterEach() {
        Settings.defaultZone = 'system'
        jest.useRealTimers()
    }

    async invoke(globals: HogFunctionInvocationGlobals, inputs: Record<string, any>) {
        const compiledInputs = await compileInputs(this.template, inputs)

        const globalsWithInputs = await this.inputsService.buildInputsWithGlobals(
            {
                ...this.template,
                inputs: compiledInputs,
            } as unknown as HogFunctionType,
            this.createGlobals(globals)
        )
        const invocation = createInvocation(globalsWithInputs, {
            ...this.template,
            template_id: this.template.id,
            hog: 'return event',
            bytecode: [],
            team_id: 1,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            deleted: false,
            inputs: compiledInputs,
            is_addon_required: false,
        })

        const result = await this.executor.execute(invocation)

        result.logs.forEach((x) => {
            if (typeof x.message === 'string' && x.message.includes('Function completed in')) {
                x.message = 'Function completed in [REPLACED]'
            }
        })
        result.invocation.id = 'invocation-id'

        return result
    }
}

export const createAdDestinationPayload = (
    globals?: DeepPartialHogFunctionInvocationGlobals
): DeepPartialHogFunctionInvocationGlobals => {
    let defaultPayload = {
        event: {
            properties: {},
            event: 'Order Completed',
            uuid: 'event-id',
            timestamp: '2025-01-01T00:00:00Z',
            distinct_id: 'distinct-id',
            elements_chain: '',
            url: 'https://us.posthog.com/projects/1/events/1234',
        },
        person: {
            id: 'person-id',
            properties: {
                email: 'example@posthog.com',
                ttclid: 'tiktok-id',
                gclid: 'google-id',
                sccid: 'snapchat-id',
                rdt_cid: 'reddit-id',
                phone: '+1234567890',
                external_id: '1234567890',
                first_name: 'Max',
                last_name: 'AI',
            },
            url: 'https://us.posthog.com/projects/1/persons/1234',
        },
    }

    defaultPayload = merge(defaultPayload, globals ?? {})

    return defaultPayload
}

export const generateTestData = (
    seedName: string,
    input_schema: HogFunctionInputSchemaType[],
    requiredFieldsOnly: boolean = false
): Record<string, any> => {
    const generateValue = (input: HogFunctionInputSchemaType): any => {
        const chance = new Chance(seedName)

        if (Array.isArray(input.choices)) {
            const choice = chance.pickone(input.choices)
            return choice.value
        }

        const getFormat = (input: HogFunctionInputSchemaType): string => {
            if (input.key === 'url') {
                return 'uri'
            } else if (input.key === 'email') {
                return 'email'
            } else if (input.key === 'uuid') {
                return 'uuid'
            } else if (input.key === 'phone') {
                return 'phone'
            }
            return 'string'
        }

        let val: any
        switch (input.type) {
            case 'boolean':
                val = chance.bool()
                break
            case 'number':
                val = chance.integer()
                break
            default:
                // covers string
                switch (getFormat(input)) {
                    case 'date': {
                        const d = chance.date()
                        val = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
                            .map((v) => String(v).padStart(2, '0'))
                            .join('-')
                        break
                    }
                    case 'date-time':
                        val = chance.date().toISOString()
                        break
                    case 'email':
                        val = chance.email()
                        break
                    case 'hostname':
                        val = chance.domain()
                        break
                    case 'ipv4':
                        val = chance.ip()
                        break
                    case 'ipv6':
                        val = chance.ipv6()
                        break
                    case 'time': {
                        const d = chance.date()
                        val = [d.getHours(), d.getMinutes(), d.getSeconds()]
                            .map((v) => String(v).padStart(2, '0'))
                            .join(':')
                        break
                    }
                    case 'uri':
                        val = chance.url()
                        break
                    case 'uuid':
                        val = chance.guid()
                        break
                    case 'phone':
                        val = chance.phone()
                        break
                    default:
                        val = chance.string()
                        break
                }
                break
        }
        return val
    }

    const inputs = input_schema.reduce((acc, input) => {
        if (input.required || requiredFieldsOnly === false) {
            acc[input.key] = input.default ?? generateValue(input)
        }
        return acc
    }, {} as Record<string, any>)

    return inputs
}
