import { PluginEvent, Properties } from '@posthog/plugin-scaffold'
import { DateTime } from 'luxon'

import { Clickhouse } from '~/tests/helpers/clickhouse'
import { fromInternalPerson } from '~/worker/ingestion/persons/person-update-batch'

import { TopicMessage } from '../../../src/kafka/producer'
import {
    ClickHousePerson,
    Hub,
    InternalPerson,
    PropertiesLastOperation,
    PropertiesLastUpdatedAt,
    Team,
} from '../../../src/types'
import { DependencyUnavailableError } from '../../../src/utils/db/error'
import { closeHub, createHub } from '../../../src/utils/db/hub'
import { PostgresUse } from '../../../src/utils/db/postgres'
import { defaultRetryConfig } from '../../../src/utils/retries'
import { UUIDT } from '../../../src/utils/utils'
import { uuidFromDistinctId } from '../../../src/worker/ingestion/person-uuid'
import { BatchWritingPersonsStoreForBatch } from '../../../src/worker/ingestion/persons/batch-writing-person-store'
import { PersonContext } from '../../../src/worker/ingestion/persons/person-context'
import { PersonEventProcessor } from '../../../src/worker/ingestion/persons/person-event-processor'
import {
    SourcePersonNotFoundError,
    TargetPersonNotFoundError,
} from '../../../src/worker/ingestion/persons/person-merge-service'
import { PersonMergeService } from '../../../src/worker/ingestion/persons/person-merge-service'
import { PersonPropertyService } from '../../../src/worker/ingestion/persons/person-property-service'
import { PersonsStoreForBatch } from '../../../src/worker/ingestion/persons/persons-store-for-batch'
import { PostgresPersonRepository } from '../../../src/worker/ingestion/persons/repositories/postgres-person-repository'
import {
    createOrganization,
    createTeam,
    fetchPostgresDistinctIdsForPerson,
    fetchPostgresPersons,
    getTeam,
    insertRow,
} from '../../helpers/sql'

jest.setTimeout(30000)

async function createPerson(
    hub: Hub,
    createdAt: DateTime,
    properties: Properties,
    propertiesLastUpdatedAt: PropertiesLastUpdatedAt,
    propertiesLastOperation: PropertiesLastOperation,
    teamId: number,
    isUserId: number | null,
    isIdentified: boolean,
    uuid: string,
    distinctIds?: { distinctId: string; version?: number }[]
): Promise<InternalPerson> {
    const personRepository = new PostgresPersonRepository(hub.db.postgres)
    const result = await personRepository.createPerson(
        createdAt,
        properties,
        propertiesLastUpdatedAt,
        propertiesLastOperation,
        teamId,
        isUserId,
        isIdentified,
        uuid,
        distinctIds
    )
    if (!result.success) {
        throw new Error('Failed to create person')
    }
    await hub.db.kafkaProducer.queueMessages(result.messages)
    return result.person
}

async function flushPersonStoreToKafka(hub: Hub, personStore: PersonsStoreForBatch, kafkaAcks: Promise<void>) {
    const kafkaMessages = await personStore.flush()
    await hub.db.kafkaProducer.queueMessages(kafkaMessages.map((message) => message.topicMessage))
    await hub.db.kafkaProducer.flush()
    await kafkaAcks
    return kafkaMessages
}

describe('PersonState.processEvent()', () => {
    let hub: Hub
    let clickhouse: Clickhouse
    let personRepository: PostgresPersonRepository

    let teamId: number
    let mainTeam: Team
    let organizationId: string

    // Common Distinct IDs (and their deterministic UUIDs) used in tests below.
    const newUserDistinctId = 'new-user'
    let newUserUuid: string
    const oldUserDistinctId = 'old-user'
    let oldUserUuid: string
    const firstUserDistinctId = 'first'
    let firstUserUuid: string
    const secondUserDistinctId = 'second'
    let secondUserUuid: string

    let timestamp: DateTime
    let timestamp2: DateTime
    let timestampch: string

    beforeAll(async () => {
        hub = await createHub({})
        clickhouse = Clickhouse.create()
        await clickhouse.exec('SYSTEM STOP MERGES')

        organizationId = await createOrganization(hub.db.postgres)
    })

    beforeEach(async () => {
        teamId = await createTeam(hub.db.postgres, organizationId)
        mainTeam = (await getTeam(hub, teamId))!
        timestamp = DateTime.fromISO('2020-01-01T12:00:05.200Z').toUTC()
        timestamp2 = DateTime.fromISO('2020-02-02T12:00:05.200Z').toUTC()
        timestampch = '2020-01-01 12:00:05.000'

        newUserUuid = uuidFromDistinctId(teamId, newUserDistinctId)
        oldUserUuid = uuidFromDistinctId(teamId, oldUserDistinctId)
        firstUserUuid = uuidFromDistinctId(teamId, firstUserDistinctId)
        secondUserUuid = uuidFromDistinctId(teamId, secondUserDistinctId)

        personRepository = new PostgresPersonRepository(hub.db.postgres)
        jest.spyOn(personRepository, 'fetchPerson')
        jest.spyOn(personRepository, 'updatePerson')

        defaultRetryConfig.RETRY_INTERVAL_DEFAULT = 0
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
        jest.restoreAllMocks()
    })

    afterAll(async () => {
        await closeHub(hub)
        await clickhouse.exec('SYSTEM START MERGES')
        clickhouse.close()
    })

    function personProcessor(
        event: Partial<PluginEvent>,
        propertyService?: PersonPropertyService,
        mergeService?: PersonMergeService,
        customHub?: Hub,
        processPerson = true,
        timestampParam = timestamp,
        team = mainTeam
    ) {
        const fullEvent = {
            team_id: teamId,
            properties: {},
            ...event,
        }

        const personsStore = new BatchWritingPersonsStoreForBatch(
            personRepository,
            customHub ? customHub.db.kafkaProducer : hub.db.kafkaProducer
        )

        const context = new PersonContext(
            fullEvent as any,
            team,
            event.distinct_id!,
            timestampParam,
            processPerson,
            customHub ? customHub.db.kafkaProducer : hub.db.kafkaProducer,
            personsStore,
            0
        )
        const processor = new PersonEventProcessor(
            context,
            propertyService ?? new PersonPropertyService(context),
            mergeService ?? new PersonMergeService(context)
        )
        return processor
    }

    function personPropertyService(
        event: Partial<PluginEvent>,
        customHub?: Hub,
        processPerson = true,
        timestampParam = timestamp,
        team = mainTeam,
        updateIsIdentified: boolean = false
    ) {
        const fullEvent = {
            team_id: teamId,
            properties: {},
            ...event,
        }

        const personsStore = new BatchWritingPersonsStoreForBatch(
            personRepository,
            customHub ? customHub.db.kafkaProducer : hub.db.kafkaProducer
        )

        const context = new PersonContext(
            fullEvent as PluginEvent,
            team,
            event.distinct_id!,
            timestampParam,
            processPerson,
            customHub ? customHub.db.kafkaProducer : hub.db.kafkaProducer,
            personsStore,
            0
        )
        context.updateIsIdentified = updateIsIdentified
        return new PersonPropertyService(context)
    }

    function personMergeService(
        event: Partial<PluginEvent>,
        customHub?: Hub,
        customPersonRepository?: PostgresPersonRepository,
        processPerson = true,
        timestampParam = timestamp,
        team = mainTeam
    ) {
        const fullEvent = {
            team_id: teamId,
            properties: {},
            ...event,
        }

        const personsStore = new BatchWritingPersonsStoreForBatch(
            customPersonRepository ??
                (customHub ? new PostgresPersonRepository(customHub.db.postgres) : personRepository),
            customHub ? customHub.db.kafkaProducer : hub.db.kafkaProducer
        )

        const context = new PersonContext(
            fullEvent as any,
            team,
            event.distinct_id!,
            timestampParam,
            processPerson,
            customHub ? customHub.db.kafkaProducer : hub.db.kafkaProducer,
            personsStore,
            0
        )
        return new PersonMergeService(context)
    }

    const sortPersons = (persons: InternalPerson[]) => persons.sort((a, b) => Number(a.id) - Number(b.id))

    async function fetchPostgresPersonsH() {
        return await fetchPostgresPersons(hub.db, teamId)
    }

    async function fetchPersonsRows() {
        const query = `SELECT * FROM person FINAL WHERE team_id = ${teamId} ORDER BY _offset`
        return await clickhouse.query<ClickHousePerson>(query)
    }

    async function fetchOverridesForDistinctId(distinctId: string) {
        const query = `SELECT * FROM person_distinct_id_overrides_mv FINAL WHERE team_id = ${teamId} AND distinct_id = '${distinctId}'`
        return await clickhouse.query(query)
    }

    async function fetchPersonsRowsWithVersionHigerEqualThan(version = 1) {
        const query = `SELECT * FROM person FINAL WHERE team_id = ${teamId} AND version >= ${version}`
        return await clickhouse.query(query)
    }

    async function fetchDistinctIdsClickhouse(person: InternalPerson) {
        return clickhouse.fetchDistinctIdValues(person)
    }

    async function fetchDistinctIdsClickhouseVersion1() {
        const query = `SELECT distinct_id FROM person_distinct_id2 FINAL WHERE team_id = ${teamId} AND version = 1`
        return await clickhouse.query(query)
    }

    describe('on person creation', () => {
        it('creates deterministic person uuids that are different between teams', async () => {
            const event_uuid = new UUIDT().toString()
            const primaryTeamId = teamId
            const [personPrimaryTeam, kafkaAcks] = await personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                uuid: event_uuid,
            }).updateProperties()

            const otherTeamId = await createTeam(hub.db.postgres, organizationId)
            const otherTeam = (await getTeam(hub, otherTeamId))!
            teamId = otherTeamId
            const [personOtherTeam, kafkaAcksOther] = await personPropertyService(
                {
                    event: '$pageview',
                    distinct_id: newUserDistinctId,
                    uuid: event_uuid,
                },
                undefined,
                true,
                timestamp,
                otherTeam
            ).updateProperties()

            await hub.db.kafkaProducer.flush()
            await kafkaAcks
            await kafkaAcksOther

            expect(personPrimaryTeam.uuid).toEqual(uuidFromDistinctId(primaryTeamId, newUserDistinctId))
            expect(personOtherTeam.uuid).toEqual(uuidFromDistinctId(otherTeamId, newUserDistinctId))
            expect(personPrimaryTeam.uuid).not.toEqual(personOtherTeam.uuid)
        })

        it('returns an ephemeral user object when $process_person_profile=false', async () => {
            const event_uuid = new UUIDT().toString()

            const hubParam = undefined
            const processPerson = false
            const [fakePerson, kafkaAcks] = await personProcessor(
                {
                    event: '$pageview',
                    distinct_id: newUserDistinctId,
                    uuid: event_uuid,
                    properties: { $set: { should_be_dropped: 100 } },
                },
                undefined,
                undefined,
                hubParam,
                processPerson
            ).processEvent()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(fakePerson).toEqual(
                expect.objectContaining({
                    team_id: teamId,
                    uuid: newUserUuid, // deterministic even though no user rows were created
                    properties: {}, // empty even though there was a $set attempted
                    created_at: DateTime.utc(1970, 1, 1, 0, 0, 5), // fake person created_at
                })
            )
            expect(fakePerson.force_upgrade).toBeUndefined()

            // verify there is no Postgres person
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(0)

            // verify there are no Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(fakePerson as InternalPerson)
            expect(distinctIds).toEqual(expect.arrayContaining([]))
        })

        it('overrides are created only when distinct_id is in posthog_personlessdistinctid', async () => {
            // oldUserDistinctId exists, and 'old2' will merge into it, but not create an override
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])

            // newUserDistinctId exists, and 'new2' will merge into it, and will create an override
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const personRepository = new PostgresPersonRepository(hub.db.postgres)
            await personRepository.addPersonlessDistinctId(teamId, 'new2')

            const hubParam = undefined
            const processPerson = true
            const [_person, kafkaAcks] = await personProcessor(
                {
                    event: '$identify',
                    distinct_id: oldUserDistinctId,
                    properties: {
                        $anon_distinct_id: 'old2',
                    },
                },
                undefined,
                undefined,
                hubParam,
                processPerson
            ).processEvent()

            const [_person2, kafkaAcks2] = await personProcessor(
                {
                    event: '$identify',
                    distinct_id: newUserDistinctId,
                    properties: {
                        $anon_distinct_id: 'new2',
                    },
                },
                undefined,
                undefined,
                hubParam,
                processPerson
            ).processEvent()

            await hub.db.kafkaProducer.flush()
            await kafkaAcks
            await kafkaAcks2

            // new2 has an override, because it was in posthog_personlessdistinctid
            await clickhouse.delayUntilEventIngested(() => fetchOverridesForDistinctId('new2'))
            const chOverrides = await fetchOverridesForDistinctId('new2')
            expect(chOverrides.length).toEqual(1)
            expect(chOverrides).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        distinct_id: 'new2',
                        person_id: newUserUuid,
                        version: '1',
                    }),
                ])
            )

            // old2 has no override, because it wasn't in posthog_personlessdistinctid
            const chOverridesOld = await fetchOverridesForDistinctId('old2')
            expect(chOverridesOld.length).toEqual(0)
        })

        it('force_upgrade works', async () => {
            const _oldPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])

            const hubParam = undefined
            let processPerson = true
            const [_person, kafkaAcks] = await personProcessor(
                {
                    event: '$identify',
                    distinct_id: newUserDistinctId,
                    properties: {
                        $anon_distinct_id: oldUserDistinctId,
                    },
                },
                undefined,
                undefined,
                hubParam,
                processPerson
            ).processEvent()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // Using the `distinct_id` again with `processPerson=false` results in
            // `force_upgrade=true` and real Person `uuid` and `created_at`
            processPerson = false
            const event_uuid = new UUIDT().toString()
            const timestampParam = timestamp.plus({ minutes: 5 }) // Event needs to happen after Person creation
            const [fakePerson, kafkaAcks2] = await personProcessor(
                {
                    event: '$pageview',
                    distinct_id: newUserDistinctId,
                    uuid: event_uuid,
                    properties: { $set: { should_be_dropped: 100 } },
                },
                undefined,
                undefined,
                hubParam,
                processPerson,
                timestampParam
            ).processEvent()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks2

            expect(fakePerson).toEqual(
                expect.objectContaining({
                    team_id: teamId,
                    uuid: oldUserUuid, // *old* user, because it existed before the merge
                    properties: {}, // empty even though there was a $set attempted
                    created_at: timestamp, // *not* the fake person created_at
                    force_upgrade: true,
                })
            )
        })

        it('force_upgrade is ignored if team.person_processing_opt_out is true', async () => {
            mainTeam.person_processing_opt_out = true
            const _oldPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])

            const hubParam = undefined
            let processPerson = true
            const [_person, kafkaAcks] = await personProcessor(
                {
                    event: '$identify',
                    distinct_id: newUserDistinctId,
                    properties: {
                        $anon_distinct_id: oldUserDistinctId,
                    },
                },
                undefined,
                undefined,
                hubParam,
                processPerson
            ).processEvent()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // Using the `distinct_id` again with `processPerson=false` results in
            // `force_upgrade=true` and real Person `uuid` and `created_at`
            processPerson = false
            const event_uuid = new UUIDT().toString()
            const timestampParam = timestamp.plus({ minutes: 5 }) // Event needs to happen after Person creation
            const [fakePerson, kafkaAcks2] = await personProcessor(
                {
                    event: '$pageview',
                    distinct_id: newUserDistinctId,
                    uuid: event_uuid,
                    properties: { $set: { should_be_dropped: 100 } },
                },
                undefined,
                undefined,
                hubParam,
                processPerson,
                timestampParam
            ).processEvent()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks2

            expect(fakePerson.force_upgrade).toBeUndefined()
        })

        it('creates person if they are new', async () => {
            const event_uuid = new UUIDT().toString()
            const [person, kafkaAcks] = await personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                uuid: event_uuid,
                // `null_byte` validates that `sanitizeJsonbValue` is working as expected
                properties: { $set: { null_byte: '\u0000' } },
            }).updateProperties()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $creator_event_uuid: event_uuid, null_byte: '\uFFFD' },
                    created_at: timestamp,
                    version: 0,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)
            expect(personRepository.updatePerson).not.toHaveBeenCalled()

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(person)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([newUserDistinctId]))
        })

        it('does not attach existing person properties to $process_person_profile=false events', async () => {
            const originalEventUuid = new UUIDT().toString()
            const [person, kafkaAcks] = await personProcessor({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                uuid: originalEventUuid,
                properties: { $set: { c: 420 } },
            }).processEvent()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $creator_event_uuid: originalEventUuid, c: 420 },
                    created_at: timestamp,
                    version: 0,
                    is_identified: false,
                })
            )

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(person)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([newUserDistinctId]))

            // OK, a person now exists with { c: 420 }, let's prove the properties come back out
            // of the DB.
            const [personVerifyProps] = await personProcessor({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                uuid: new UUIDT().toString(),
                properties: {},
            }).processEvent()
            expect(personVerifyProps.properties).toEqual({ $creator_event_uuid: originalEventUuid, c: 420 })

            // But they don't when $process_person_profile=false
            const [processPersonFalseResult] = await personProcessor(
                {
                    event: '$pageview',
                    distinct_id: newUserDistinctId,
                    uuid: new UUIDT().toString(),
                    properties: {},
                },
                undefined,
                undefined,
                hub,
                false
            ).processEvent()
            expect(processPersonFalseResult.properties).toEqual({})
        })

        it('handles person being created in a race condition', async () => {
            const _newPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            jest.spyOn(personRepository, 'fetchPerson').mockImplementationOnce(() => {
                return Promise.resolve(undefined)
            })

            const [person, kafkaAcks] = await personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
            }).handleUpdate()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // if creation fails we should return the person that another thread already created
            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: {},
                    created_at: timestamp,
                    version: 0,
                    is_identified: false,
                })
            )
            expect(personRepository.updatePerson).not.toHaveBeenCalled()
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(person)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(person)
            expect(distinctIds).toEqual(expect.arrayContaining([newUserDistinctId]))
        })

        it('handles person being created in a race condition updates properties if needed', async () => {
            const createdPerson = await createPerson(
                hub,
                timestamp,
                { b: 3, c: 4 },
                {},
                {},
                teamId,
                null,
                false,
                newUserUuid,
                [{ distinctId: newUserDistinctId }]
            )

            let callCounter = 0
            const fetchPersonSpy = jest.spyOn(personRepository, 'fetchPerson').mockImplementationOnce(() => {
                callCounter++
                if (callCounter < 2) {
                    return Promise.resolve(undefined)
                }
                return Promise.resolve(createdPerson)
            })

            const propertyService = personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set_once: { c: 3, e: 4 },
                    $set: { b: 4 },
                },
            })
            const [person, kafkaAcks] = await propertyService.handleUpdate()
            const context = propertyService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            // Explicitly restore the spy to prevent Jest state corruption
            fetchPersonSpy.mockRestore()

            // if creation fails we should return the person that another thread already created
            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: { b: 4, c: 4, e: 4 },
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })
            expect(personRepository.updatePerson).toHaveBeenCalledTimes(1)
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: false,
                properties: { b: 4, c: 4, e: 4 },
                version: 1,
            })

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(person)
            expect(distinctIds).toEqual(expect.arrayContaining([newUserDistinctId]))
        })

        it('creates person with properties', async () => {
            const [person, kafkaAcks] = await personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set_once: { a: 1, b: 2 },
                    $set: { b: 3, c: 4 },
                },
            }).updateProperties()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: { a: 1, b: 3, c: 4 },
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)
            expect(personRepository.updatePerson).not.toHaveBeenCalled()

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(person)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([newUserDistinctId]))
        })
    })

    describe('on person update', () => {
        it('updates person properties', async () => {
            await createPerson(hub, timestamp, { b: 3, c: 4, toString: {} }, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])
            const propertyService = personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set_once: { c: 3, e: 4 },
                    $set: { b: 4, toString: 1, null_byte: '\u0000' },
                },
            })
            const [person, kafkaAcks] = await propertyService.updateProperties()
            const context = propertyService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: { b: 4, c: 4, e: 4, toString: 1, null_byte: '\u0000' },
                is_identified: false,
            })

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const postgresPersons = sortPersons(await fetchPostgresPersonsH())
            expect(postgresPersons.length).toEqual(1)
            expect(postgresPersons[0]).toMatchObject({
                id: person.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: false,
                // `null_byte` validates that `sanitizeJsonbValue` is working as expected
                properties: { b: 4, c: 4, e: 4, toString: 1, null_byte: '\uFFFD' },
                version: 1,
            })
        })

        it.each(['$$heatmap', '$exception'])('does not update person properties for %s', async (event: string) => {
            const originalPersonProperties = { b: 3, c: 4, toString: {} }

            await createPerson(hub, timestamp, originalPersonProperties, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const [person, kafkaAcks] = await personPropertyService({
                event: event,
                distinct_id: newUserDistinctId,
                properties: {
                    $set_once: { c: 3, e: 4 },
                    $set: { b: 4, toString: 1, null_byte: '\u0000' },
                },
            }).updateProperties()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: originalPersonProperties,
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(person)
        })

        it('updates person properties - no update if not needed', async () => {
            await createPerson(hub, timestamp, { $current_url: 123 }, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])
            const [person, kafkaAcks] = await personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { $current_url: 4 },
                },
            }).updateProperties()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $current_url: 4 }, // Here we keep 4 for passing forward to PoE
                    created_at: timestamp,
                    version: 0,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons).toEqual([
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $current_url: 123 }, // We didn 't update this as it's auto added and it's not a person event
                    created_at: timestamp,
                    version: 0,
                    is_identified: false,
                }),
            ])
        })

        it('updates person properties - always update for person events', async () => {
            await createPerson(hub, timestamp, { $current_url: 123 }, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const propertyService = personPropertyService({
                event: '$set',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { $current_url: 4 },
                },
            })
            const [person, kafkaAcks] = await propertyService.updateProperties()
            const context = propertyService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $current_url: 4 }, // Here we keep 4 for passing forward to PoE
                    created_at: timestamp,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(
                expect.objectContaining({
                    id: person.id,
                    uuid: newUserUuid,
                    created_at: timestamp,
                    is_identified: false,
                    properties: { $current_url: 4 },
                    version: 1,
                })
            ) // We updated PG as it's a person event
        })

        it('updates person properties - always update if undefined before', async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const propertyService = personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { $initial_current_url: 4 },
                },
            })
            const [person, kafkaAcks] = await propertyService.updateProperties()
            const context = propertyService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $initial_current_url: 4 }, // Here we keep 4 for passing forward to PoE
                    created_at: timestamp,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(
                expect.objectContaining({
                    id: person.id,
                    uuid: newUserUuid,
                    created_at: timestamp,
                    is_identified: false,
                    properties: { $initial_current_url: 4 },
                    version: 1,
                })
            ) // We updated PG as it was undefined before
        })

        it('updates person properties - always update for initial properties', async () => {
            await createPerson(
                hub,
                timestamp,
                { $initial_current_url: 123 },
                {},
                {},
                teamId,
                null,
                false,
                newUserUuid,
                [{ distinctId: newUserDistinctId }]
            )

            const propertyService = personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { $initial_current_url: 4 },
                },
            })
            const [person, kafkaAcks] = await propertyService.updateProperties()
            const context = propertyService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { $initial_current_url: 4 }, // Here we keep 4 for passing forward to PoE
                    created_at: timestamp,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(
                expect.objectContaining({
                    id: person.id,
                    uuid: newUserUuid,
                    created_at: timestamp,
                    is_identified: false,
                    properties: { $initial_current_url: 4 },
                    version: 1,
                })
            ) // We updated PG as it's an initial property
        })

        it('updating with cached person data shortcuts to update directly', async () => {
            const personInitial = await createPerson(
                hub,
                timestamp,
                { b: 3, c: 4 },
                {},
                {},
                teamId,
                null,
                false,
                newUserUuid,
                [{ distinctId: newUserDistinctId }]
            )
            const event = {
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set_once: { c: 3, e: 4 },
                    $set: { b: 4 },
                },
            }

            // create mock merge service,
            const mergeService = personMergeService(event)
            jest.spyOn(mergeService, 'handleIdentifyOrAlias').mockReturnValue(
                Promise.resolve([personInitial, Promise.resolve()])
            )

            const personS = personProcessor(event, undefined, mergeService)
            const [person, kafkaAcks] = await personS.processEvent()
            const context = personS.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { b: 4, c: 4, e: 4 },
                    created_at: timestamp,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(0)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: false,
                properties: { b: 4, c: 4, e: 4 },
                version: 1,
            })
        })

        it('does not update person if not needed', async () => {
            await createPerson(hub, timestamp, { b: 3, c: 4 }, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const propertyService = personPropertyService({
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: {
                    $set_once: { c: 3 },
                    $set: { b: 3 },
                },
            })
            const [person, kafkaAcks] = await propertyService.updateProperties()
            const context = propertyService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { b: 3, c: 4 },
                    created_at: timestamp,
                    version: 0,
                    is_identified: false,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)
            expect(personRepository.updatePerson).not.toHaveBeenCalled()

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(person)
        })

        it('marks user as is_identified', async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const personS = personPropertyService(
                {
                    event: '$pageview',
                    distinct_id: newUserDistinctId,
                    properties: {},
                },
                undefined,
                true,
                timestamp,
                mainTeam,
                true
            )

            const [person, kafkaAcks] = await personS.updateProperties()
            const context = personS.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)
            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: {},
                    created_at: timestamp,
                    is_identified: true,
                })
            )

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)
            expect(personRepository.updatePerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(
                expect.objectContaining({
                    id: person.id,
                    uuid: newUserUuid,
                    created_at: timestamp,
                    is_identified: true,
                    properties: {},
                    version: 1,
                })
            )

            await personS.updateProperties()
            expect(personRepository.updatePerson).toHaveBeenCalledTimes(1)
        })

        it('handles race condition when person provided has been merged', async () => {
            // TODO: we don't handle this currently person having been changed / updated properties can get overridden
            // Pass in a person, but another thread merges it - we shouldn't error in this case, but instead if we couldn't update we should retry?
            const mergeDeletedPerson: InternalPerson = {
                created_at: timestamp,
                version: 0,
                id: '0',
                team_id: teamId,
                properties: { a: 5, b: 7 },
                is_user_id: 0,
                is_identified: false,
                uuid: uuidFromDistinctId(teamId, 'deleted-user'),
                properties_last_updated_at: {},
                properties_last_operation: null,
            }
            await createPerson(hub, timestamp, { a: 6, c: 8 }, {}, {}, teamId, null, true, newUserUuid, [
                { distinctId: newUserDistinctId },
                { distinctId: oldUserDistinctId },
            ]) // the merged Person

            const event = {
                event: '$pageview',
                distinct_id: newUserDistinctId,
                properties: { $set: { a: 7, d: 9 } },
            }
            // create mock merge service
            const mergeService = personMergeService(event)
            jest.spyOn(mergeService, 'handleIdentifyOrAlias').mockReturnValue(
                Promise.resolve([mergeDeletedPerson, Promise.resolve()])
            )

            const personS = personProcessor(event, undefined, mergeService)
            const context = personS.getContext()

            const [person, kafkaAcks] = await personS.processEvent()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            // Return logic is still unaware that merge happened
            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: mergeDeletedPerson.uuid,
                properties: { a: 7, b: 7, d: 9 },
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })

            expect(personRepository.fetchPerson).toHaveBeenCalledTimes(1)
            expect(personRepository.updatePerson).toHaveBeenCalledTimes(2)

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: { a: 7, c: 8, d: 9 },
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })
        })
    })

    describe('on $identify event', () => {
        it(`no-op when $anon_distinct_id not passed`, async () => {
            const mergeService: PersonMergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { foo: 'bar' },
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(undefined)
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(0)
        })

        it(`creates person with both distinct_ids and marks user as is_identified when $anon_distinct_id passed`, async () => {
            const mergeService: PersonMergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { foo: 'bar' },
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { foo: 'bar' },
                    created_at: timestamp,
                    version: 0,
                    is_identified: true,
                })
            )

            expect(personRepository.updatePerson).toHaveBeenCalledTimes(1)

            // verify Postgres persons
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(1)
            expect(persons[0]).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: { foo: 'bar' },
                    created_at: timestamp,
                    version: 1,
                    is_identified: true,
                })
            )

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })

        it(`marks is_identified to be updated when no changes to distinct_ids but $anon_distinct_id passe`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
                { distinctId: oldUserDistinctId },
            ])
            const mergeService: PersonMergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: {},
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })
            expect(mergeService.getUpdateIsIdentified()).toBeTruthy()

            // verify Postgres persons
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: false,
                properties: {},
                version: 1,
            })
        })

        it(`add distinct id and marks user is_identified when passed $anon_distinct_id person does not exists and distinct_id does`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])
            const mergeService: PersonMergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            const persons = await fetchPostgresPersonsH()
            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: newUserUuid,
                properties: {},
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })
            expect(mergeService.getUpdateIsIdentified()).toBeTruthy()

            // verify Postgres persons
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: false,
                properties: {},
                version: 0,
            })

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })

        it(`add distinct id and marks user as is_identified when passed $anon_distinct_id person exists and distinct_id does not`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])

            const mergeService: PersonMergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            const persons = await fetchPostgresPersonsH()

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: oldUserUuid,
                properties: {},
                created_at: timestamp,
                version: 0,
                is_identified: false,
            })
            expect(mergeService.getUpdateIsIdentified()).toBeTruthy()
            expect(personRepository.updatePerson).not.toHaveBeenCalled()

            // verify Postgres persons
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: oldUserUuid,
                created_at: timestamp,
                is_identified: false,
                properties: {},
                version: 0,
            })

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })

        it(`merge into distinct_id person and marks user as is_identified when both persons have is_identified false`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])
            await createPerson(hub, timestamp2, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const mergeService: PersonMergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: expect.any(String),
                properties: {},
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: true,
                properties: {},
                version: 1,
            })
            expect([newUserUuid, oldUserUuid]).toContain(persons[0].uuid)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))

            // verify ClickHouse persons
            await clickhouse.delayUntilEventIngested(() => fetchPersonsRowsWithVersionHigerEqualThan(), 2) // wait until merge and delete processed
            const clickhousePersons = await fetchPersonsRows() // but verify full state
            expect(clickhousePersons.length).toEqual(2)
            expect(clickhousePersons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        properties: '{}',
                        created_at: timestampch,
                        version: '1',
                        is_identified: 1,
                    }),
                    expect.objectContaining({
                        id: expect.any(String),
                        is_deleted: 1,
                        version: '100',
                    }),
                ])
            )
            expect(new Set(clickhousePersons.map((p) => p.id))).toEqual(new Set([newUserUuid, oldUserUuid]))

            // verify ClickHouse distinct_ids
            await clickhouse.delayUntilEventIngested(() => fetchDistinctIdsClickhouseVersion1())
            const clickHouseDistinctIds = await fetchDistinctIdsClickhouse(persons[0])
            expect(clickHouseDistinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })

        it(`merge into distinct_id person and marks user as is_identified when distinct_id user is identified and $anon_distinct_id user is not`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])
            await createPerson(hub, timestamp2, {}, {}, {}, teamId, null, true, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: expect.any(String),
                    properties: {},
                    created_at: timestamp,
                    version: 1,
                    is_identified: true,
                })
            )

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: true,
                properties: {},
                version: 1,
            })
            expect([newUserUuid, oldUserUuid]).toContain(persons[0].uuid)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))

            // verify ClickHouse persons
            await clickhouse.delayUntilEventIngested(() => fetchPersonsRowsWithVersionHigerEqualThan(), 2) // wait until merge and delete processed
            const clickhousePersons = await fetchPersonsRows() // but verify full state
            expect(clickhousePersons.length).toEqual(2)
            expect(clickhousePersons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        properties: '{}',
                        created_at: timestampch,
                        version: '1',
                        is_identified: 1,
                    }),
                    expect.objectContaining({
                        id: expect.any(String),
                        is_deleted: 1,
                        version: '100',
                    }),
                ])
            )
            expect(new Set(clickhousePersons.map((p) => p.id))).toEqual(new Set([newUserUuid, oldUserUuid]))

            // verify ClickHouse distinct_ids
            await clickhouse.delayUntilEventIngested(() => fetchDistinctIdsClickhouseVersion1())
            const clickHouseDistinctIds = await fetchDistinctIdsClickhouse(persons[0])
            expect(clickHouseDistinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })

        it(`does not merge people when distinct_id user is not identified and $anon_distinct_id user is`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, true, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])
            await createPerson(hub, timestamp2, {}, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const personS = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await personS.handleIdentifyOrAlias()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(personS.getUpdateIsIdentified()).toBeTruthy()
            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: {},
                    created_at: timestamp2,
                    version: 0,
                    is_identified: false,
                })
            )

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(2)
            expect(persons[0]).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: oldUserUuid,
                    properties: {},
                    created_at: timestamp,
                    version: 0,
                    is_identified: true,
                })
            )
            expect(persons[1]).toEqual(person)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId]))
            const distinctIds2 = await hub.db.fetchDistinctIdValues(persons[1])
            expect(distinctIds2).toEqual(expect.arrayContaining([newUserDistinctId]))
        })

        it(`does not merge people when both users are identified`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, true, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])
            await createPerson(hub, timestamp2, {}, {}, {}, teamId, null, true, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])
            const [person, kafkaAcks] = await personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $anon_distinct_id: oldUserDistinctId,
                },
            }).handleIdentifyOrAlias()
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: newUserUuid,
                    properties: {},
                    created_at: timestamp2,
                    version: 0,
                    is_identified: true,
                })
            )

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(2)
            expect(persons[0]).toMatchObject({
                id: expect.any(String),
                uuid: oldUserUuid,
                properties: {},
                created_at: timestamp,
                version: 0,
                is_identified: true,
            })
            expect(persons[1]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                created_at: timestamp2,
                is_identified: true,
                properties: {},
                version: 0,
            })

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId]))
            const distinctIds2 = await hub.db.fetchDistinctIdValues(persons[1])
            expect(distinctIds2).toEqual(expect.arrayContaining([newUserDistinctId]))
        })

        it(`merge into distinct_id person and updates properties with $set/$set_once`, async () => {
            await createPerson(hub, timestamp, { a: 1, b: 2 }, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])
            await createPerson(hub, timestamp2, { b: 3, c: 4, d: 5 }, {}, {}, teamId, null, false, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])

            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: newUserDistinctId,
                properties: {
                    $set: { d: 6, e: 7 },
                    $set_once: { a: 8, f: 9 },
                    $anon_distinct_id: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: expect.any(String),
                properties: { a: 1, b: 3, c: 4, d: 6, e: 7, f: 9 },
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                properties: { a: 1, b: 3, c: 4, d: 6, e: 7, f: 9 },
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })
            expect([newUserUuid, oldUserUuid]).toContain(persons[0].uuid)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))

            // verify ClickHouse persons
            await clickhouse.delayUntilEventIngested(() => fetchPersonsRowsWithVersionHigerEqualThan(), 2) // wait until merge and delete processed
            const clickhousePersons = await fetchPersonsRows() // but verify full state
            expect(clickhousePersons.length).toEqual(2)
            expect(clickhousePersons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        properties: JSON.stringify({ a: 1, b: 3, c: 4, d: 6, e: 7, f: 9 }),
                        created_at: timestampch,
                        version: '1',
                        is_identified: 1,
                    }),
                    expect.objectContaining({
                        id: expect.any(String),
                        is_deleted: 1,
                        version: '100',
                    }),
                ])
            )
            expect(new Set(clickhousePersons.map((p) => p.id))).toEqual(new Set([newUserUuid, oldUserUuid]))

            // verify ClickHouse distinct_ids
            await clickhouse.delayUntilEventIngested(() => fetchDistinctIdsClickhouseVersion1())
            const clickHouseDistinctIds = await fetchDistinctIdsClickhouse(persons[0])
            expect(clickHouseDistinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })

        it(`handles race condition when other thread creates the user`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])

            // Fake the race by assuming createPerson was called before the addDistinctId creation above
            jest.spyOn(personRepository, 'addDistinctId').mockImplementation(
                async (person, distinctId): Promise<TopicMessage[]> => {
                    await createPerson(
                        hub,
                        timestamp,
                        {},
                        {},
                        {},
                        teamId,
                        null,
                        false,
                        uuidFromDistinctId(teamId, distinctId),
                        [{ distinctId }]
                    )

                    return await personRepository.addDistinctId(person, distinctId, 0) // this throws
                }
            )

            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: oldUserDistinctId,
                properties: {
                    $anon_distinct_id: newUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)
            jest.spyOn(personRepository, 'addDistinctId').mockRestore()

            // if creation fails we should return the person that another thread already created
            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: oldUserUuid,
                properties: {},
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })

            // expect(personRepository.updatePerson).not.toHaveBeenCalled()
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: expect.any(String),
                uuid: oldUserUuid,
                properties: {},
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([newUserDistinctId]))
        })
    })

    describe('on $create_alias events', () => {
        // All the functionality tests are provided above in $identify tests, here we just make sure the calls are equivalent
        it('calls merge on $identify as expected', async () => {
            const state: PersonMergeService = personMergeService(
                {
                    event: '$identify',
                    distinct_id: newUserDistinctId,
                    properties: { $anon_distinct_id: oldUserDistinctId },
                },
                hub
            )
            jest.spyOn(state, 'merge').mockImplementation(() => {
                return Promise.resolve([undefined, Promise.resolve()])
            })
            await state.handleIdentifyOrAlias()
            expect(state.merge).toHaveBeenCalledWith(oldUserDistinctId, newUserDistinctId, teamId, timestamp)
            jest.spyOn(state, 'merge').mockRestore()
        })

        it('calls merge on $create_alias as expected', async () => {
            const state: PersonMergeService = personMergeService(
                {
                    event: '$create_alias',
                    distinct_id: newUserDistinctId,
                    properties: { alias: oldUserDistinctId },
                },
                hub
            )
            jest.spyOn(state, 'merge').mockImplementation(() => {
                return Promise.resolve([undefined, Promise.resolve()])
            })

            await state.handleIdentifyOrAlias()
            expect(state.merge).toHaveBeenCalledWith(oldUserDistinctId, newUserDistinctId, teamId, timestamp)
            jest.spyOn(state, 'merge').mockRestore()
        })

        it('calls merge on $merge_dangerously as expected', async () => {
            const state: PersonMergeService = personMergeService(
                {
                    event: '$merge_dangerously',
                    distinct_id: newUserDistinctId,
                    properties: { alias: oldUserDistinctId },
                },
                hub
            )
            jest.spyOn(state, 'merge').mockImplementation(() => {
                return Promise.resolve([undefined, Promise.resolve()])
            })

            await state.handleIdentifyOrAlias()
            expect(state.merge).toHaveBeenCalledWith(oldUserDistinctId, newUserDistinctId, teamId, timestamp)
            jest.spyOn(state, 'merge').mockRestore()
        })
    })

    describe('on $merge_dangerously events', () => {
        // only difference between $merge_dangerously and $identify
        it(`merge_dangerously can merge people when alias id user is identified`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, true, oldUserUuid, [
                { distinctId: oldUserDistinctId },
            ])
            await createPerson(hub, timestamp2, {}, {}, {}, teamId, null, true, newUserUuid, [
                { distinctId: newUserDistinctId },
            ])
            const mergeService = personMergeService({
                event: '$merge_dangerously',
                distinct_id: newUserDistinctId,
                properties: {
                    alias: oldUserDistinctId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    uuid: expect.any(String),
                    properties: {},
                    created_at: timestamp,
                    version: 1,
                    is_identified: true,
                })
            )

            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: person!.id,
                uuid: newUserUuid,
                created_at: timestamp,
                is_identified: true,
                properties: {},
                version: 1,
            })
            expect([newUserUuid, oldUserUuid]).toContain(persons[0].uuid)

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(persons[0])
            expect(distinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))

            // verify ClickHouse persons
            await clickhouse.delayUntilEventIngested(() => fetchPersonsRowsWithVersionHigerEqualThan(), 2) // wait until merge and delete processed
            const clickhousePersons = await fetchPersonsRows() // but verify full state
            expect(clickhousePersons.length).toEqual(2)
            expect(clickhousePersons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        properties: '{}',
                        created_at: timestampch,
                        version: '1',
                        is_identified: 1,
                    }),
                    expect.objectContaining({
                        id: expect.any(String),
                        is_deleted: 1,
                        version: '100',
                    }),
                ])
            )
            expect(new Set(clickhousePersons.map((p) => p.id))).toEqual(new Set([newUserUuid, oldUserUuid]))

            // verify ClickHouse distinct_ids
            await clickhouse.delayUntilEventIngested(() => fetchDistinctIdsClickhouseVersion1())
            const clickHouseDistinctIds = await fetchDistinctIdsClickhouse(persons[0])
            expect(clickHouseDistinctIds).toEqual(expect.arrayContaining([oldUserDistinctId, newUserDistinctId]))
        })
    })

    describe('illegal aliasing', () => {
        const illegalIds = ['', '   ', 'null', 'undefined', '"undefined"', '[object Object]', '"[object Object]"']
        it.each(illegalIds)('stops $identify if current distinct_id is illegal: `%s`', async (illegalId: string) => {
            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: illegalId,
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(undefined)
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(0)
        })

        it.each(illegalIds)('stops $identify if $anon_distinct_id is illegal: `%s`', async (illegalId: string) => {
            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: 'some_distinct_id',
                properties: {
                    $anon_distinct_id: illegalId,
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(undefined)
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(0)
        })

        it('stops $create_alias if current distinct_id is illegal', async () => {
            const mergeService = personMergeService({
                event: '$create_alias',
                distinct_id: 'false',
                properties: {
                    alias: 'some_distinct_id',
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(undefined)
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(0)
        })

        it('stops $create_alias if alias is illegal', async () => {
            const mergeService = personMergeService({
                event: '$create_alias',
                distinct_id: 'some_distinct_id',
                properties: {
                    alias: 'null',
                },
            })
            const [person, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toEqual(undefined)
            const persons = await fetchPostgresPersonsH()
            expect(persons.length).toEqual(0)
        })
    })

    describe('foreign key updates in other tables', () => {
        it('handles feature flag hash key overrides with no conflicts', async () => {
            const anonPerson = await createPerson(
                hub,
                timestamp.minus({ hours: 1 }),
                {},
                {},
                {},
                teamId,
                null,
                false,
                uuidFromDistinctId(teamId, 'anonymous_id'),
                [{ distinctId: 'anonymous_id' }]
            )

            const identifiedPerson = await createPerson(
                hub,
                timestamp,
                {},
                {},
                {},
                teamId,
                null,
                false,
                uuidFromDistinctId(teamId, 'new_distinct_id'),
                [{ distinctId: 'new_distinct_id' }]
            )

            // existing overrides
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: anonPerson.id,
                feature_flag_key: 'beta-feature',
                hash_key: 'example_id',
            })
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: identifiedPerson.id,
                feature_flag_key: 'multivariate-flag',
                hash_key: 'example_id',
            })

            // this event means the person will be merged
            // so hashkeyoverride should be updated to the new person id whichever way we merged
            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: 'new_distinct_id',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                    distinct_id: 'new_distinct_id',
                },
            })
            const [_, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            const [person] = await fetchPostgresPersonsH()
            expect([identifiedPerson.id, anonPerson.id]).toContain(person.id)
            expect(await hub.db.fetchDistinctIdValues(person)).toEqual(['anonymous_id', 'new_distinct_id'])
            expect(person.is_identified).toEqual(true)

            const result = await hub.db.postgres.query(
                PostgresUse.COMMON_WRITE,
                `SELECT "feature_flag_key", "person_id", "hash_key" FROM "posthog_featureflaghashkeyoverride" WHERE "team_id" = $1`,
                [teamId],
                'testQueryHashKeyOverride'
            )
            expect(result.rows).toEqual(
                expect.arrayContaining([
                    {
                        feature_flag_key: 'beta-feature',
                        person_id: person.id,
                        hash_key: 'example_id',
                    },
                    {
                        feature_flag_key: 'multivariate-flag',
                        person_id: person.id,
                        hash_key: 'example_id',
                    },
                ])
            )
        })

        it('handles feature flag hash key overrides with some conflicts handled gracefully', async () => {
            const anonPerson = await createPerson(
                hub,
                timestamp.minus({ hours: 1 }),
                {},
                {},
                {},
                teamId,
                null,
                false,
                uuidFromDistinctId(teamId, 'anonymous_id'),
                [{ distinctId: 'anonymous_id' }]
            )

            const identifiedPerson = await createPerson(
                hub,
                timestamp,
                {},
                {},
                {},
                teamId,
                null,
                false,
                uuidFromDistinctId(teamId, 'new_distinct_id'),
                [{ distinctId: 'new_distinct_id' }]
            )

            // existing overrides for both anonPerson and identifiedPerson
            // which implies a clash when they are merged
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: anonPerson.id,
                feature_flag_key: 'beta-feature',
                hash_key: 'anon_id',
            })
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: identifiedPerson.id,
                feature_flag_key: 'beta-feature',
                hash_key: 'identified_id',
            })
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: anonPerson.id,
                feature_flag_key: 'multivariate-flag',
                hash_key: 'other_different_id',
            })

            // this event means the person will be merged
            // so hashkeyoverride should be updated to be either
            // we're optimizing on updates to not write on conflict and ordering is not guaranteed
            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: 'new_distinct_id',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                    distinct_id: 'new_distinct_id',
                },
            })
            const [_, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            const [person] = await fetchPostgresPersonsH()
            expect([identifiedPerson.id, anonPerson.id]).toContain(person.id)
            expect(await hub.db.fetchDistinctIdValues(person)).toEqual(['anonymous_id', 'new_distinct_id'])
            expect(person.is_identified).toEqual(true)

            const result = await hub.db.postgres.query(
                PostgresUse.COMMON_WRITE,
                `SELECT "feature_flag_key", "person_id", "hash_key" FROM "posthog_featureflaghashkeyoverride" WHERE "team_id" = $1`,
                [teamId],
                'testQueryHashKeyOverride'
            )
            expect(result.rows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        feature_flag_key: 'beta-feature',
                        person_id: person.id,
                        hash_key: expect.any(String), // either anon_id or identified_id
                    }),
                    {
                        feature_flag_key: 'multivariate-flag',
                        person_id: person.id,
                        hash_key: 'other_different_id',
                    },
                ])
            )
        })

        it('handles feature flag hash key overrides with no old overrides but existing new person overrides', async () => {
            const anonPerson = await createPerson(
                hub,
                timestamp.minus({ hours: 1 }),
                {},
                {},
                {},
                teamId,
                null,
                false,
                uuidFromDistinctId(teamId, 'anonymous_id'),
                [{ distinctId: 'anonymous_id' }]
            )

            const identifiedPerson = await createPerson(
                hub,
                timestamp,
                {},
                {},
                {},
                teamId,
                null,
                false,
                uuidFromDistinctId(teamId, 'new_distinct_id'),
                [{ distinctId: 'new_distinct_id' }]
            )
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: identifiedPerson.id,
                feature_flag_key: 'beta-feature',
                hash_key: 'example_id',
            })
            await insertRow(hub.db.postgres, 'posthog_featureflaghashkeyoverride', {
                team_id: teamId,
                person_id: identifiedPerson.id,
                feature_flag_key: 'multivariate-flag',
                hash_key: 'different_id',
            })

            const mergeService = personMergeService({
                event: '$identify',
                distinct_id: 'new_distinct_id',
                properties: {
                    $anon_distinct_id: 'anonymous_id',
                },
            })
            const [_, kafkaAcks] = await mergeService.handleIdentifyOrAlias()
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            const [person] = await fetchPostgresPersonsH()
            expect([identifiedPerson.id, anonPerson.id]).toContain(person.id)
            expect(await hub.db.fetchDistinctIdValues(person)).toEqual(['anonymous_id', 'new_distinct_id'])
            expect(person.is_identified).toEqual(true)

            const result = await hub.db.postgres.query(
                PostgresUse.COMMON_WRITE,
                `SELECT "feature_flag_key", "person_id", "hash_key" FROM "posthog_featureflaghashkeyoverride" WHERE "team_id" = $1`,
                [teamId],
                'testQueryHashKeyOverride'
            )
            expect(result.rows).toEqual(
                expect.arrayContaining([
                    {
                        feature_flag_key: 'beta-feature',
                        person_id: person.id,
                        hash_key: 'example_id',
                    },
                    {
                        feature_flag_key: 'multivariate-flag',
                        person_id: person.id,
                        hash_key: 'different_id',
                    },
                ])
            )
        })
    })
    describe('on persons merges', () => {
        // For some reason these tests failed if I ran them with a hub shared
        // with other tests, so I'm creating a new hub for each test.
        let hub: Hub

        beforeEach(async () => {
            hub = await createHub({})
            personRepository = new PostgresPersonRepository(hub.db.postgres)

            jest.spyOn(personRepository, 'fetchPerson')
            jest.spyOn(personRepository, 'updatePerson')
        })

        afterEach(async () => {
            jest.clearAllTimers()
            jest.useRealTimers()
            jest.restoreAllMocks()
            await closeHub(hub)
        })

        it(`no-op if persons already merged`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, true, firstUserUuid, [
                { distinctId: firstUserDistinctId },
                { distinctId: secondUserDistinctId },
            ])

            const state: PersonMergeService = personMergeService({}, hub)
            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')
            const [person, kafkaAcks] = await state.merge(secondUserDistinctId, firstUserDistinctId, teamId, timestamp)
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            expect(person).toMatchObject({
                id: expect.any(String),
                uuid: firstUserUuid,
                properties: {},
                created_at: timestamp,
                version: 0,
                is_identified: true,
            })
            expect(personRepository.updatePerson).not.toHaveBeenCalled()
            expect(hub.db.kafkaProducer.queueMessages).not.toHaveBeenCalled()
        })

        it(`postgres and clickhouse get updated`, async () => {
            const first = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])

            const second = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const mergeService: PersonMergeService = personMergeService({}, hub, personRepository)
            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')
            const [person, kafkaAcks] = await mergeService.mergePeople({
                mergeInto: first,
                mergeIntoDistinctId: firstUserDistinctId,
                otherPerson: second,
                otherPersonDistinctId: secondUserDistinctId,
            })
            const context = mergeService.getContext()
            await flushPersonStoreToKafka(hub, context.personStore, kafkaAcks)

            expect(person).toMatchObject({
                id: first.id,
                uuid: firstUserUuid,
                properties: {},
                created_at: timestamp,
                version: 1,
                is_identified: true,
            })

            expect(personRepository.updatePerson).toHaveBeenCalledTimes(1)
            expect(hub.db.kafkaProducer.queueMessages).toHaveBeenCalledTimes(2)
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0]).toMatchObject({
                id: first.id,
                uuid: firstUserUuid,
                created_at: timestamp,
                is_identified: true,
                properties: {},
                version: 1,
            })

            // verify Postgres distinct_ids
            const distinctIds = await hub.db.fetchDistinctIdValues(person)
            expect(distinctIds).toEqual(expect.arrayContaining([firstUserDistinctId, secondUserDistinctId]))

            // verify ClickHouse persons
            await clickhouse.delayUntilEventIngested(() => fetchPersonsRowsWithVersionHigerEqualThan(), 2) // wait until merge and delete processed
            const clickhousePersons = await fetchPersonsRows() // but verify full state
            expect(clickhousePersons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: firstUserUuid,
                        properties: '{}',
                        created_at: timestampch,
                        version: '1',
                        is_identified: 1,
                    }),
                    expect.objectContaining({
                        id: secondUserUuid,
                        is_deleted: 1,
                        version: '100',
                    }),
                ])
            )

            // verify ClickHouse distinct_ids
            await clickhouse.delayUntilEventIngested(() => fetchDistinctIdsClickhouseVersion1())
            const clickHouseDistinctIds = await fetchDistinctIdsClickhouse(person)
            expect(clickHouseDistinctIds).toEqual(expect.arrayContaining([firstUserDistinctId, secondUserDistinctId]))
        })

        it(`throws if postgres unavailable`, async () => {
            const first = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])

            const second = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])
            const state: PersonMergeService = personMergeService({}, hub)
            // break postgres
            const error = new DependencyUnavailableError('testing', 'Postgres', new Error('test'))
            jest.spyOn(hub.db.postgres, 'transaction').mockImplementation(() => {
                throw error
            })
            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')
            await expect(
                state.mergePeople({
                    mergeInto: first,
                    mergeIntoDistinctId: firstUserDistinctId,
                    otherPerson: second,
                    otherPersonDistinctId: secondUserDistinctId,
                })
            ).rejects.toThrow(error)
            await hub.db.kafkaProducer.flush()

            expect(hub.db.postgres.transaction).toHaveBeenCalledTimes(1)
            jest.spyOn(hub.db.postgres, 'transaction').mockRestore()
            expect(hub.db.kafkaProducer.queueMessages).not.toBeCalled()
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        uuid: firstUserUuid,
                        properties: {},
                        created_at: timestamp,
                        version: 0,
                        is_identified: false,
                    }),
                    expect.objectContaining({
                        id: expect.any(String),
                        uuid: secondUserUuid,
                        properties: {},
                        created_at: timestamp,
                        version: 0,
                        is_identified: false,
                    }),
                ])
            )
        })

        it(`retries merges up to retry limit if postgres down`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])
            const state: PersonMergeService = personMergeService({}, hub)
            // break postgres
            const error = new DependencyUnavailableError('testing', 'Postgres', new Error('test'))
            jest.spyOn(state, 'mergePeople').mockImplementation(() => {
                throw error
            })
            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')
            await expect(state.merge(secondUserDistinctId, firstUserDistinctId, teamId, timestamp)).rejects.toThrow(
                error
            )

            await hub.db.kafkaProducer.flush()

            expect(state.mergePeople).toHaveBeenCalledTimes(3)
            jest.spyOn(state, 'mergePeople').mockRestore()
            expect(hub.db.kafkaProducer.queueMessages).not.toBeCalled()
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.any(String),
                        uuid: firstUserUuid,
                        properties: {},
                        created_at: timestamp,
                        version: 0,
                        is_identified: false,
                    }),
                    expect.objectContaining({
                        id: expect.any(String),
                        uuid: secondUserUuid,
                        properties: {},
                        created_at: timestamp,
                        version: 0,
                        is_identified: false,
                    }),
                ])
            )
        })

        it(`handleIdentifyOrAlias does not throw on merge failure`, async () => {
            // TODO: This the current state, we should probably change it
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const state: PersonMergeService = personMergeService(
                {
                    event: '$merge_dangerously',
                    distinct_id: firstUserDistinctId,
                    properties: { alias: secondUserDistinctId },
                },
                hub
            )
            // break postgres
            const error = new DependencyUnavailableError('testing', 'Postgres', new Error('test'))
            jest.spyOn(state, 'mergePeople').mockImplementation(() => {
                throw error
            })
            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')
            await state.handleIdentifyOrAlias()
            await hub.db.kafkaProducer.flush()

            expect(state.mergePeople).toHaveBeenCalledTimes(3)
            jest.spyOn(state, 'mergePeople').mockRestore()
            expect(hub.db.kafkaProducer.queueMessages).not.toBeCalled()
            // verify Postgres persons
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.stringMatching(/^[0-9]+$/),
                        uuid: firstUserUuid,
                        properties: {},
                        created_at: timestamp,
                        version: 0,
                        is_identified: false,
                    }),
                    expect.objectContaining({
                        id: expect.stringMatching(/^[0-9]+$/),
                        uuid: secondUserUuid,
                        properties: {},
                        created_at: timestamp,
                        version: 0,
                        is_identified: false,
                    }),
                ])
            )
        })

        it(`retries merge when source person is deleted during merge transaction`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const state: PersonMergeService = personMergeService({})
            let attemptCount = 0

            // Mock moveDistinctIds to throw SourcePersonNotFoundError on first attempt, succeed on retry
            const originalMoveDistinctIds = personRepository.moveDistinctIds
            jest.spyOn(personRepository, 'moveDistinctIds').mockImplementation(async (...args) => {
                attemptCount++
                if (attemptCount === 1) {
                    throw new SourcePersonNotFoundError('Source person no longer exists')
                }
                return originalMoveDistinctIds.call(hub.db, ...args)
            })

            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')
            jest.spyOn(personRepository, 'fetchPerson')

            // Should succeed after retry
            const [person, kafkaAcks] = await state.merge(firstUserDistinctId, secondUserDistinctId, teamId, timestamp)
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // Verify that moveDistinctIds was called twice (initial + retry)
            expect(personRepository.moveDistinctIds).toHaveBeenCalledTimes(2)

            // Verify merge succeeded
            expect(person).not.toBeUndefined()
            expect(person?.uuid).toBe(secondUserUuid) // merged into second user

            // Verify that fetchPerson was called for both users
            expect(personRepository.fetchPerson).toHaveBeenCalledWith(teamId, firstUserDistinctId, {
                useReadReplica: false,
            })

            expect(personRepository.fetchPerson).toHaveBeenCalledWith(teamId, secondUserDistinctId, {
                useReadReplica: false,
            })

            // Verify correct number of persons remain
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0].uuid).toBe(secondUserUuid)
        })

        it(`retries merge when target person is deleted during merge transaction`, async () => {
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const state: PersonMergeService = personMergeService({})
            let attemptCount = 0

            // Mock moveDistinctIds to throw TargetPersonNotFoundError on first attempt, succeed on retry
            const originalMoveDistinctIds = personRepository.moveDistinctIds
            jest.spyOn(personRepository, 'moveDistinctIds').mockImplementation(async (...args) => {
                attemptCount++
                if (attemptCount === 1) {
                    throw new TargetPersonNotFoundError('Target person no longer exists')
                }
                return originalMoveDistinctIds.call(hub.db, ...args)
            })

            jest.spyOn(personRepository, 'fetchPerson')
            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')

            // Should succeed after retry
            const [person, kafkaAcks] = await state.merge(firstUserDistinctId, secondUserDistinctId, teamId, timestamp)
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // Verify that moveDistinctIds was called twice (initial + retry)
            expect(personRepository.moveDistinctIds).toHaveBeenCalledTimes(2)

            // Verify merge succeeded
            expect(person).not.toBeUndefined()
            expect(person?.uuid).toBe(secondUserUuid) // merged into second user

            // Verify that fetchPerson was called for both users
            expect(personRepository.fetchPerson).toHaveBeenCalledWith(teamId, firstUserDistinctId, {
                useReadReplica: false,
            })

            expect(personRepository.fetchPerson).toHaveBeenCalledWith(teamId, secondUserDistinctId, {
                useReadReplica: false,
            })

            // Verify correct number of persons remain
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0].uuid).toBe(secondUserUuid)
        })

        it(`skips merge when source person no longer exists after retry`, async () => {
            const firstPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            const secondPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const state: PersonMergeService = personMergeService({})
            let attemptCount = 0
            let fetchPersonCalls = 0

            // Mock fetchPerson to return null on retry (person no longer exists)
            jest.spyOn(personRepository, 'fetchPerson').mockImplementation(() => {
                fetchPersonCalls++
                // Fetch source person
                if (fetchPersonCalls === 1) {
                    return Promise.resolve(firstPerson)
                }

                // Fetch target person
                if (fetchPersonCalls === 2) {
                    return Promise.resolve(secondPerson)
                }

                // Fetch for retry
                return Promise.resolve(undefined)
            })

            // Mock moveDistinctIds to throw SourcePersonNotFoundError on first attempt
            jest.spyOn(personRepository, 'moveDistinctIds').mockImplementation(() => {
                attemptCount++
                if (attemptCount === 1) {
                    throw new SourcePersonNotFoundError('Source person no longer exists')
                }
                // Should not reach here since person lookup returns null
                throw new Error('Should not retry when person no longer exists')
            })

            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')

            // Should return target person without error
            const [person, kafkaAcks] = await state.merge(firstUserDistinctId, secondUserDistinctId, teamId, timestamp)
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // Verify that moveDistinctIds was only called once (no retry since person doesn't exist)
            expect(personRepository.moveDistinctIds).toHaveBeenCalledTimes(1)

            // Verify we got the target person back
            expect(person).not.toBeUndefined()
            expect(person?.uuid).toBe(secondUserUuid)

            // Verify both persons still exist since merge was skipped
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(2)
        })

        it(`skips merge when target person no longer exists after retry`, async () => {
            const firstPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            const secondPerson = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const state: PersonMergeService = personMergeService({})
            let attemptCount = 0
            let fetchPersonCalls = 0

            jest.spyOn(personRepository, 'fetchPerson').mockImplementation(() => {
                fetchPersonCalls++
                // Fetch source person
                if (fetchPersonCalls === 1) {
                    return Promise.resolve(firstPerson)
                }

                // Fetch target person
                if (fetchPersonCalls === 2) {
                    return Promise.resolve(secondPerson)
                }

                // Fetch for retry
                return Promise.resolve(undefined)
            })

            // Mock moveDistinctIds to throw TargetPersonNotFoundError on first attempt
            jest.spyOn(personRepository, 'moveDistinctIds').mockImplementation(() => {
                attemptCount++
                if (attemptCount === 1) {
                    throw new TargetPersonNotFoundError('Target person no longer exists')
                }
                // Should not reach here since person lookup returns null
                throw new Error('Should not retry when person no longer exists')
            })

            jest.spyOn(hub.db.kafkaProducer, 'queueMessages')

            // Should return target person without error
            const [person, kafkaAcks] = await state.merge(firstUserDistinctId, secondUserDistinctId, teamId, timestamp)
            await hub.db.kafkaProducer.flush()
            await kafkaAcks

            // Verify that moveDistinctIds was only called once (no retry since person doesn't exist)
            expect(personRepository.moveDistinctIds).toHaveBeenCalledTimes(1)

            // Verify we got the original target person back (which was the second user)
            expect(person).not.toBeUndefined()
            expect(person?.uuid).toBe(secondUserUuid)

            // Verify both persons still exist since merge was skipped
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(2)
        })

        it('clears cache and refreshes to new person when merge retry finds distinctId points to different person', async () => {
            // Create initial persons
            const person1 = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            const person2 = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            // Create person 3 who will be the "new" person that the distinctId points to after refresh
            const person3Uuid = new UUIDT().toString()
            const person3 = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, person3Uuid, [
                { distinctId: 'person3-distinct-id' },
            ])

            // Create a merge service with batch writing store for a $merge_dangerously event
            const mergeService: PersonMergeService = personMergeService(
                {
                    event: '$merge_dangerously',
                    distinct_id: secondUserDistinctId,
                },
                hub
            )
            const context = mergeService.getContext()

            const batchStore = context.personStore as BatchWritingPersonsStoreForBatch

            batchStore.setCachedPersonForUpdate(
                teamId,
                firstUserDistinctId,
                fromInternalPerson(person1, firstUserDistinctId)
            )

            // Verify the cache is populated
            expect(batchStore.getCachedPersonForUpdateByDistinctId(teamId, firstUserDistinctId)).toBeTruthy()

            // Mock removeDistinctIdFromCache to verify it's called
            const removeDistinctIdFromCacheSpy = jest.spyOn(batchStore, 'removeDistinctIdFromCache')

            // Mock moveDistinctIds to first move the distinct ID to person3 (simulating race condition), then succeed
            let moveDistinctIdsCalls = 0
            const originalMoveDistinctIds = batchStore.moveDistinctIds.bind(batchStore)

            // Mock the batch store method which is what gets called through the transaction wrapper
            const moveDistinctIdsSpy = jest
                .spyOn(batchStore, 'moveDistinctIds')
                .mockImplementation(async (source, target, distinctId, tx) => {
                    moveDistinctIdsCalls++
                    if (moveDistinctIdsCalls === 1) {
                        // Simulate the race condition: move firstUserDistinctId to person3
                        // This simulates another process moving the distinct ID during the merge
                        await personRepository.inRawTransaction('test', async (tx) => {
                            await personRepository.moveDistinctIds(person1, person3, tx)
                            await personRepository.deletePerson(person1, tx)
                        })

                        // First call fails with SourcePersonNotFoundError (person1 no longer exists)
                        return Promise.resolve({
                            success: false,
                            error: 'SourceNotFound',
                            message: 'Source person no longer exists',
                        })
                    }
                    // Second call succeeds - call the original method
                    return originalMoveDistinctIds(source, target, distinctId, tx)
                })

            // Attempt to merge persons - this should trigger the retry logic
            const [person] = await mergeService.mergePeople({
                mergeInto: person2,
                mergeIntoDistinctId: secondUserDistinctId,
                otherPerson: person1, // This person "no longer exists"
                otherPersonDistinctId: firstUserDistinctId,
            })

            // Verify the cache was cleared during retry
            expect(removeDistinctIdFromCacheSpy).toHaveBeenCalledWith(teamId, firstUserDistinctId)

            // Verify moveDistinctIds was called twice (first failed with person1, second succeeded with person3)
            expect(moveDistinctIdsSpy).toHaveBeenCalledTimes(2)

            // Verify we got the target person back
            expect(person).toMatchObject({
                id: person2.id,
                uuid: secondUserUuid,
            })

            // Verify only 1 person exists
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0].uuid).toBe(secondUserUuid)

            // Verify the distinct ID is now pointing to the target person
            const distinctIds = await fetchPostgresDistinctIdsForPerson(hub.db, person2.id)
            expect(distinctIds.length).toEqual(3)
            expect(distinctIds).toMatchObject(
                expect.arrayContaining([firstUserDistinctId, secondUserDistinctId, 'person3-distinct-id'])
            )
        })

        it('refreshes to new person when merging dangerously two people', async () => {
            // Create initial persons
            const person1 = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, true, firstUserUuid, [
                { distinctId: firstUserDistinctId },
            ])
            const person2 = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, true, secondUserUuid, [
                { distinctId: secondUserDistinctId },
            ])

            const person3Uuid = new UUIDT().toString()
            const person3 = await createPerson(hub, timestamp, {}, {}, {}, teamId, null, false, person3Uuid, [
                { distinctId: 'person3-distinct-id' },
            ])

            // Add one distinct id entry to each person, simulating a previous merge
            await personRepository.addDistinctId(person1, 'person1-merged-distinct-id', 1)
            await personRepository.addDistinctId(person2, 'person2-merged-distinct-id', 1)

            const mergeService: PersonMergeService = personMergeService({
                event: '$merge_dangerously',
            })

            // Mock moveDistinctIds to first move the distinct ID to person3 (simulating race condition), then succeed
            let moveDistinctIdsCalls = 0
            const originalMoveDistinctIds = personRepository.moveDistinctIds
            const moveDistinctIdsSpy = jest
                .spyOn(personRepository, 'moveDistinctIds')
                .mockImplementation(async (...args) => {
                    moveDistinctIdsCalls++
                    if (moveDistinctIdsCalls === 1) {
                        // Simulate the race condition: move firstUserDistinctId to person3
                        // This simulates another process moving the distinct ID during the merge
                        await originalMoveDistinctIds.call(personRepository, person1, person3)
                        await personRepository.deletePerson(person1)

                        // First call fails with SourcePersonNotFoundError (person1 no longer exists)
                        return Promise.resolve({
                            success: false,
                            error: 'SourceNotFound',
                            message: 'Source person no longer exists',
                        })
                    }
                    // Second call succeeds - call the original method
                    return originalMoveDistinctIds.call(personRepository, ...args)
                })

            // Attempt to merge persons - this should trigger the retry logic
            const [person] = await mergeService.mergePeople({
                mergeInto: person2,
                mergeIntoDistinctId: secondUserDistinctId,
                otherPerson: person1, // This person "no longer exists"
                otherPersonDistinctId: firstUserDistinctId,
            })

            // Verify moveDistinctIds was called twice (first failed with person1, second succeeded with person3)
            expect(moveDistinctIdsSpy).toHaveBeenCalledTimes(2)

            // Verify we got the target person back
            expect(person).toMatchObject({
                id: person2.id,
                uuid: secondUserUuid,
            })

            // Verify only 1 person exists
            const persons = sortPersons(await fetchPostgresPersonsH())
            expect(persons.length).toEqual(1)
            expect(persons[0].uuid).toBe(secondUserUuid)

            // Verify the distinct ID is now pointing to the target person
            const distinctIds = await fetchPostgresDistinctIdsForPerson(hub.db, person2.id)
            expect(distinctIds.length).toEqual(5)
            expect(distinctIds).toMatchObject(
                expect.arrayContaining([
                    firstUserDistinctId,
                    secondUserDistinctId,
                    'person3-distinct-id',
                    'person1-merged-distinct-id',
                    'person2-merged-distinct-id',
                ])
            )
        })
    })
})
