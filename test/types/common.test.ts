import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentVerification, HumanVerification, NewVerification } from '../../src/store/store.js';
import { idConstructor } from '../../src/types/common.js';
import type { Created, Identified, New } from '../../src/types/common.js';

describe('idConstructor', () =>
{
    const widgetId = idConstructor<'Widget'>('WidgetId');

    it('should accept a positive integer and return it unchanged', () =>
    {
        // Act
        const id = widgetId(42);

        // Assert
        expect(id).toBe(42);
    });

    it('should reject zero', () =>
    {
        // Act + Assert
        expect(() => widgetId(0)).toThrow('Not a valid WidgetId: 0');
    });

    it('should reject a negative number', () =>
    {
        // Act + Assert
        expect(() => widgetId(-7)).toThrow('Not a valid WidgetId: -7');
    });

    it('should reject a non-integer', () =>
    {
        // Act + Assert
        expect(() => widgetId(1.5)).toThrow('Not a valid WidgetId: 1.5');
    });

    it('should reject NaN', () =>
    {
        // Act + Assert
        expect(() => widgetId(Number('garbage'))).toThrow('Not a valid WidgetId: NaN');
    });
});

// Compile-time contract: New<T> subtracts per union member (the comment on
// New in src/types/common.ts walks through why that matters).
describe('New', () =>
{
    type Dutch = Identified<'Address'> & Created & { country_code: 'NL'; region: null; postal_code: string };
    type Foreign = Identified<'Address'> & Created & { country_code: 'DE'; region: string | null; state: string };

    it('should keep each member of a union entity apart', () =>
    {
        // Assert
        expectTypeOf<New<Dutch | Foreign>>().toEqualTypeOf<New<Dutch> | New<Foreign>>();
    });

    it('should reject a mix of two members\' fields', () =>
    {
        // Assert: one merged object would accept this — 'NL' with a region.
        expectTypeOf({ country_code: 'NL' as const, region: 'Bayern', postal_code: '1234AB' })
            .not.toExtend<New<Dutch | Foreign>>();
    });

    it('should keep the fields only one member has', () =>
    {
        // Assert
        expectTypeOf<Extract<New<Dutch | Foreign>, { country_code: 'DE' }>>().toHaveProperty('state');
    });

    it('should derive the verification union member by member', () =>
    {
        // Assert
        expectTypeOf<NewVerification>().toEqualTypeOf<New<AgentVerification> | New<HumanVerification>>();
    });
});
