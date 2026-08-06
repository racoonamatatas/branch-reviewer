import { describe, expect, it } from 'vitest';
import { idConstructor } from '../../src/types/common.js';

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
