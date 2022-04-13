import assert from 'assert';
import NodeUtils from 'util';
import isEqual from 'lodash/isEqual';
import isPlainObject from 'lodash/isPlainObject.js';
import isUndefined from 'lodash/isUndefined';
import lowerFirst from 'lodash/lowerFirst';
import omit from 'lodash/omit';
import omitBy from 'lodash/omitBy';
import type { Class } from 'type-fest';
import { AssociationError } from '../errors/index.js';
import type { Model, ModelAttributeColumnOptions, ModelStatic } from '../model';
import type { Sequelize } from '../sequelize';
import * as deprecations from '../utils/deprecations.js';
import * as Utils from '../utils/index.js';
import type { OmitConstructors } from '../utils/index.js';
import { isModelStatic, isSameInitialModel } from '../utils/model-utils.js';
import type { Association, AssociationOptions, NormalizedAssociationOptions } from './base';

export function checkNamingCollision(source: ModelStatic<any>, associationName: string): void {
  if (Object.prototype.hasOwnProperty.call(source.getAttributes(), associationName)) {
    throw new Error(
      `Naming collision between attribute '${associationName}'`
      + ` and association '${associationName}' on model ${source.name}`
      + '. To remedy this, change the "as" options in your association definition',
    );
  }
}

export function addForeignKeyConstraints(
  newAttribute: ModelAttributeColumnOptions,
  source: ModelStatic<Model>,
  options: AssociationOptions<string>,
  key: string,
): void {
  // FK constraints are opt-in: users must either set `foreignKeyConstraints`
  // on the association, or request an `onDelete` or `onUpdate` behavior

  if (options.foreignKeyConstraint || options.onDelete || options.onUpdate) {
    // Find primary keys: composite keys not supported with this approach
    const primaryKeys = Object.keys(source.primaryKeys)
      .map(primaryKeyAttribute => source.getAttributes()[primaryKeyAttribute].field || primaryKeyAttribute);

    if (primaryKeys.length === 1 || !primaryKeys.includes(key)) {
      newAttribute.references = {
        model: source.getTableName(),
        key: key || primaryKeys[0],
      };

      newAttribute.onDelete = options.onDelete;
      newAttribute.onUpdate = options.onUpdate;
    }
  }
}

/**
 * Mixin (inject) association methods to model prototype
 *
 * @private
 *
 * @param association instance
 * @param mixinTargetPrototype Model prototype
 * @param methods Method names to inject
 * @param aliases Mapping between model and association method names
 *
 */
export function mixinMethods<A extends Association, Aliases extends Record<string, string>>(
  association: A,
  mixinTargetPrototype: Model,
  methods: Array<keyof A | keyof Aliases>,
  aliases?: Aliases,
): void {
  for (const method of methods) {
    // @ts-expect-error
    const targetMethodName = association.accessors[method];

    // don't override custom methods
    if (Object.prototype.hasOwnProperty.call(mixinTargetPrototype, targetMethodName)) {
      continue;
    }

    // @ts-expect-error
    const realMethod = aliases?.[method] || method;

    Object.defineProperty(mixinTargetPrototype, targetMethodName, {
      enumerable: false,
      value(...params: any[]) {
        // @ts-expect-error
        return association[realMethod](this, ...params);
      },
    });
  }
}

/**
 * Used to prevent users from instantiating Associations themselves.
 * Instantiating associations is not safe as it mutates the Model object.
 *
 * @internal
 * @private do not expose outside sequelize
 */
export const AssociationConstructorSecret = Symbol('AssociationConstructorPrivateKey');

export function getModel<M extends Model>(
  sequelize: Sequelize,
  model: string | ModelStatic<M>,
): ModelStatic<M> | null {
  if (typeof model === 'string') {
    if (!sequelize.isDefined(model)) {
      return null;
    }

    return sequelize.model(model) as ModelStatic<M>;
  }

  return model;
}

export function removeUndefined<T>(val: T): T {
  return omitBy(val, isUndefined) as T;
}

export function assertAssociationUnique(
  type: Class<Association>,
  source: ModelStatic<any>,
  target: ModelStatic<any>,
  options: NormalizedAssociationOptions<any>,
  parent: Association | undefined,
) {
  const as = options.as;

  const existingAssociation = source.associations[as];
  if (!existingAssociation) {
    return;
  }

  const incompatibilityStatus = getAssociationsIncompatibilityStatus(existingAssociation, type, target, options);
  if ((parent || existingAssociation.parentAssociation) && incompatibilityStatus == null) {
    return;
  }

  const existingRoot = existingAssociation.rootAssociation;

  if (!parent && existingRoot === existingAssociation) {
    throw new AssociationError(`You have defined two associations with the same name "${as}" on the model "${source.name}". Use another alias using the "as" parameter.`);
  }

  throw new AssociationError(`
${parent ? `The association "${parent.as}" needs to define` : `You are trying to define`} the ${type.name} association "${options.as}" from ${source.name} to ${target.name},
but that child association has already been defined as ${existingAssociation.associationType}, to ${target.name} by this call:

${existingRoot.source.name}.${lowerFirst(existingRoot.associationType)}(${existingRoot.target.name}, ${NodeUtils.inspect(existingRoot._origOptions)})

That association would be re-used if compatible, but it is incompatible because ${
  incompatibilityStatus === IncompatibilityStatus.DIFFERENT_TYPES ? `their types are different (${type.name} vs ${existingAssociation.associationType})`
    : incompatibilityStatus === IncompatibilityStatus.DIFFERENT_TARGETS ? `they target different models (${target.name} vs ${existingAssociation.target.name})`
    : `their options are not reconcilable:

Options of the association to create:
${NodeUtils.inspect(omit(options, 'inverse'), { sorted: true })}

Options of the existing association:
${NodeUtils.inspect(omit(existingAssociation._origOptions as any, 'inverse'), { sorted: true })}
`}`.trim());
}

/**
 * @internal
 */
enum IncompatibilityStatus {
  DIFFERENT_TYPES = 0,
  DIFFERENT_TARGETS = 1,
  DIFFERENT_OPTIONS = 2,
}

function getAssociationsIncompatibilityStatus(
  existingAssociation: Association,
  newAssociationType: Class<Association>,
  newTarget: ModelStatic<Model>,
  newOptions: NormalizeBaseAssociationOptions<any>,
): IncompatibilityStatus | null {
  if (existingAssociation.associationType !== newAssociationType.name) {
    return IncompatibilityStatus.DIFFERENT_TYPES;
  }

  if (!isSameInitialModel(existingAssociation.target, newTarget)) {
    return IncompatibilityStatus.DIFFERENT_TARGETS;
  }

  const opts1 = omit(existingAssociation._origOptions as any, 'inverse');
  const opts2 = omit(newOptions, 'inverse');
  if (!isEqual(opts1, opts2)) {
    return IncompatibilityStatus.DIFFERENT_OPTIONS;
  }

  return null;
}

export function assertAssociationModelIsDefined(model: ModelStatic<any>): void {
  if (!model.sequelize) {
    throw new Error(`Model ${model.name} must be defined (through Model.init or Sequelize#define) before calling one of its association declaration methods.`);
  }
}

export type AssociationStatic<T extends Association> = Class<T> & OmitConstructors<typeof Association>;

export function defineAssociation<
  T extends Association,
  RawOptions extends AssociationOptions<any>,
  CleanOptions extends NormalizedAssociationOptions<any>,
>(
  type: AssociationStatic<T>,
  source: ModelStatic<Model>,
  target: ModelStatic<Model>,
  options: RawOptions,
  parent: Association<any> | undefined,
  normalizeOptions: (
    type: AssociationStatic<T>,
    options: RawOptions,
    source: ModelStatic<Model>,
    target: ModelStatic<Model>
  ) => CleanOptions,
  construct: (opts: CleanOptions) => T,
): T {
  if (!isModelStatic(target)) {
    throw new Error(`${source.name}.${lowerFirst(type.name)} called with something that's not a subclass of Sequelize.Model`);
  }

  assertAssociationModelIsDefined(source);
  assertAssociationModelIsDefined(target);

  const normalizedOptions = normalizeOptions(type, options, source, target);

  checkNamingCollision(source, normalizedOptions.as);
  assertAssociationUnique(type, source, target, normalizedOptions, parent);

  const sequelize = source.sequelize!;
  Object.defineProperty(normalizedOptions, 'sequelize', {
    configurable: true,
    get() {
      deprecations.movedSequelizeParam();

      return sequelize;
    },
  });

  if (normalizedOptions.hooks) {
    source.runHooks('beforeAssociate', { source, target, type, sequelize }, normalizedOptions);
  }

  let association;
  try {
    association = source.associations[normalizedOptions.as] as T ?? construct(normalizedOptions);
  } catch (error) {
    throw new AssociationError(
      parent
        ? `Association "${parent.as}" needs to create the ${type.name} association "${normalizedOptions.as}" from ${source.name} to ${target.name}, but it failed`
        : `Defining ${type.name} association "${normalizedOptions.as}" from ${source.name} to ${target.name} failed`,
      { cause: error as Error },
    );
  }

  if (normalizedOptions.hooks) {
    source.runHooks('afterAssociate', { source, target, type, association, sequelize }, normalizedOptions);
  }

  checkNamingCollision(source, normalizedOptions.as);

  return association;
}

export type NormalizeBaseAssociationOptions<T> = Omit<T, 'as' | 'hooks'> & {
  as: string,
  name: { singular: string, plural: string },
  hooks: boolean,
};

export function normalizeBaseAssociationOptions<T extends AssociationOptions<any>>(
  associationType: AssociationStatic<any>,
  options: T,
  source: ModelStatic<Model>,
  target: ModelStatic<Model>,
): NormalizeBaseAssociationOptions<T> {
  const isMultiAssociation = associationType.isMultiAssociation;

  let name: { singular: string, plural: string };
  let as: string;
  if (options?.as) {
    if (isPlainObject(options.as)) {
      assert(typeof options.as === 'object');
      name = options.as;
      as = isMultiAssociation ? options.as.plural : options.as.singular;
    } else {
      assert(typeof options.as === 'string');
      as = options.as;
      name = {
        plural: isMultiAssociation ? options.as : Utils.pluralize(options.as),
        singular: isMultiAssociation ? Utils.singularize(options.as) : options.as,
      };
    }
  } else {
    as = isMultiAssociation ? target.options.name.plural : target.options.name.singular;
    name = target.options.name;
  }

  return removeUndefined({
    ...options,
    hooks: options.hooks ?? false,
    as,
    name,
  });
}