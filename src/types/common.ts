// The project's type-derivation machinery. Entities are bare nouns that mix
// in server-assigned fields from Identified/Created; everything else derives
// DOWN from the entity by subtraction (New<T>), never up by extension — so a
// field like createdAt has exactly one rule saying where it belongs. Ids are
// branded: a number becomes an Id<T> only through a checking constructor.

declare const brand: unique symbol;
export type Id<T extends string> = number & { readonly [brand]: T };

// Server-assigned. Reused by every entity in the project.
export interface Identified<T extends string>
{
    id: Id<T>;
}

export interface Created
{
    createdAt: string;  // ISO 8601
}

// The one derivation rule: strip everything server-assigned.
export type New<T> = Omit<T, keyof Identified<string> | keyof Created>;

export function idConstructor<T extends string>(name: string): (n: number) => Id<T>
{
    return n =>
    {
        if (!Number.isInteger(n) || n <= 0)
        {
            throw new Error(`Not a valid ${name}: ${n}`);
        }
        return n as Id<T>;  // the only cast to Id in the project
    };
}
